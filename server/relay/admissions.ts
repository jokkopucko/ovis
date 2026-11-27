import type { DeviceConnection, DeviceRoute } from "../../shared/access.ts";

export interface SessionLine {
  readonly route: DeviceRoute;
  readonly relay?: string;
  readonly since: number;
  readonly mux: { readonly active: boolean; readonly rttMs: number | undefined; measure(): Promise<number | undefined> };
}

export const CHECK_GAP_MS = 5_000;

const NEAR: Record<DeviceRoute, number> = { lan: 0, tailscale: 1, relay: 2 };

/**
 * The signed-in sessions one PC serves, whichever way they came: the relay links (global and regional)
 * and the direct carriers count against the same limits, so no way in adds places of its own.
 */
export class SignedInSessions {
  private order = 0;
  private readonly entries = new Set<{ readonly deviceId: string; order: number; chosen: boolean; readonly close: () => void; readonly line?: SessionLine }>();

  /**
   * `max` at once, past which only a device at its `perDevice` share gets in, with up to `perDeviceCandidates` of its own over;
   * `perDevice` chosen for one device key, whose oldest gives way; at most `perDeviceCandidates`
   * not chosen yet for one device key (an app races its carriers: two direct ones and the relay)
   */
  constructor(private readonly max = 8, private readonly perDevice = 4, private readonly perDeviceCandidates = 3) {}

  get size(): number { return this.entries.size; }

  admit(deviceId: string, close: () => void, line?: SessionLine): () => void {
    const admission = this.candidate(deviceId, close, line);
    admission.chosen();
    return admission.release;
  }

  private chosenOf(deviceId: string): number {
    return [...this.entries].filter((other) => other.deviceId === deviceId && other.chosen).length;
  }

  candidate(deviceId: string, close: () => void, line?: SessionLine): { readonly release: () => void; readonly chosen: () => void } {
    const entry = { deviceId, order: ++this.order, chosen: false, close, ...(line ? { line } : {}) };
    this.entries.add(entry);
    const release = (): void => { this.entries.delete(entry); };
    // past its device's racing carriers, the oldest of them gives way: one that never opened a stream was dropped,
    // or lost on its way (a newest-gives-way rule would keep such a dead one and shut the device out)
    const waiting = [...this.entries].filter((other) => other.deviceId === deviceId && !other.chosen).sort((left, right) => left.order - right.order);
    for (const oldest of waiting.slice(0, Math.max(0, waiting.length - this.perDeviceCandidates))) {
      this.entries.delete(oldest);
      oldest.close();
    }
    // with every place taken, a device at its share still gets in (once used, its own oldest gives way) with its own
    // racing carriers, capped per device above: another device's carriers never use up its way in (#3243)
    if (this.entries.size > this.max && this.chosenOf(deviceId) < this.perDevice) {
      release();
      close();
    }
    return {
      release,
      chosen: () => {
        if (entry.chosen || !this.entries.has(entry)) return;
        entry.chosen = true;
        entry.order = ++this.order;
        // the device's own oldest give way, so a device at its share always gets its new session in
        const own = [...this.entries].filter((other) => other.deviceId === deviceId && other.chosen).sort((a, b) => a.order - b.order);
        for (const oldest of own.slice(0, Math.max(0, own.length - this.perDevice))) {
          this.entries.delete(oldest);
          oldest.close();
        }
      },
    };
  }

  connections(): Map<string, DeviceConnection> {
    const best = new Map<string, { order: number; chosen: boolean; line: SessionLine }>();
    for (const { deviceId, order, line, chosen } of this.entries) {
      if (!line?.mux.active) continue;
      const held = best.get(deviceId);
      const better = !held || (chosen !== held.chosen ? chosen
        : NEAR[line.route] !== NEAR[held.line.route] ? NEAR[line.route] < NEAR[held.line.route] : order > held.order);
      if (better) best.set(deviceId, { order, chosen, line });
    }
    return new Map([...best].map(([deviceId, { line }]) => [deviceId, {
      route: line.route, ...(line.relay === undefined ? {} : { relay: line.relay }),
      rtt_ms: line.mux.rttMs === undefined ? null : Math.round(line.mux.rttMs), since: new Date(line.since).toISOString(),
    }]));
  }

  private checking: Promise<void> | undefined;
  private checkedAt = -Infinity;

  check(timeoutMs: number, now = Date.now()): Promise<void> {
    if (this.checking) return this.checking;
    if (now - this.checkedAt < CHECK_GAP_MS) return Promise.resolve();
    this.checkedAt = now;
    this.checking = this.measureAll(timeoutMs).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async measureAll(timeoutMs: number): Promise<void> {
    let stop = (): void => {};
    const late = new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); stop = () => { clearTimeout(timer); resolve(); }; });
    await Promise.race([Promise.all([...this.entries].map((entry) => entry.line?.mux.measure())), late]);
    stop();
  }
}