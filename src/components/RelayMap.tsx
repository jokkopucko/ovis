import "./RelayMap.css";

import { Lock, MonitorSmartphone, RadioTower } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { inDashboardFilter, relayHost } from "../lib/relay/dashboard.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import type { Translate } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { mapStateDetail, mapStateWord } from "./relayPcState.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";
import {
  checkingWirePaths, clip, hubRoutedNodes, hubWireState, isDirectRoute, isRegionalRelay, layoutRelayMap,
  nodeStatusDotState, nodeWireState, placeLabel, relayHandshake, relayHandshakeMs, wire,
} from "./relayMapLayout.ts";
import type { LabelSide, PlacedHub, PlacedPc, RelayHandshake, RelayMapLayout, RelayMapModel, RelayMapNode, WireState } from "./relayMapLayout.ts";

export { clip, layoutRelayMap, placeLabel, relayHandshake, relayHandshakeMs, wire };
export type { LabelSide, PlacedHub, PlacedPc, RelayHandshake, RelayMapLayout, RelayMapModel, RelayMapNode, WireState };

export interface RelayMapProps {
  readonly map: RelayMapModel;
  readonly selectedPcId?: string | null;
  readonly onSelectPc?: (serverId: string) => void;
  readonly onSelectRelay?: (origin: string) => void;
  readonly standalone?: boolean;
}

function seenTitleOf(node: RelayMapNode, t: Translate): string {
  return node.last_seen_at === null ? t("Last seen: unknown") : `${t("Last seen")} · ${lastSeen(node.last_seen_at)}`;
}

function NodeTooltip({ node, detail, t }: { readonly node: RelayMapNode; readonly detail: string; readonly t: Translate }) {
  const iso = node.last_seen_at;
  return (
    <span className="relay-map-tooltip" role="tooltip">
      <strong>{node.name}</strong>
      <span>{detail}</span>
      <span className="relay-map-tooltip-seen">
        {iso !== null
          ? <>{t("Last seen")} · <time dateTime={iso} title={new Date(iso).toLocaleString(currentLocale())}>{lastSeen(iso)}</time></>
          : t("Last seen: unknown")}
      </span>
    </span>
  );
}

function PcHop({ node, selected, onSelectPc, t }: { readonly node: RelayMapNode; readonly selected: boolean; readonly onSelectPc?: (serverId: string) => void; readonly t: Translate }) {
  const detailWord = mapStateDetail(node, t);
  return (
    <button type="button" className="relay-map-hop-btn" data-pc-id={node.server_id} data-selected={selected ? "" : undefined} aria-current={selected ? "true" : undefined} title={`${node.name} · ${detailWord} · ${seenTitleOf(node, t)}`} onClick={() => activatePc(node.server_id, onSelectPc)}>
      <StatusDot state={nodeStatusDotState(node)} />
      <span className="relay-map-hop-name" title={node.name}>{node.name}</span>
      <small className="relay-map-hop-note">{mapStateWord(node, t)}</small>
      <NodeTooltip node={node} detail={detailWord} t={t} />
    </button>
  );
}

function activatePc(serverId: string, onSelectPc?: (id: string) => void): void {
  if (onSelectPc) onSelectPc(serverId);
  else if (typeof window !== "undefined") window.location.hash = `#pcs?pc=${encodeURIComponent(serverId)}`;
}

function activateRelay(origin: string, onSelectRelay?: (relayOrigin: string) => void): void {
  if (onSelectRelay) onSelectRelay(origin);
  else if (typeof window !== "undefined") window.location.hash = `#pcs?relay=${encodeURIComponent(relayHost(origin))}`;
}

export function RelayMap({ map, selectedPcId = null, onSelectPc, onSelectRelay, standalone = false }: RelayMapProps) {
  const t = useT();
  const totalPcs = map.hubs.reduce((sum, hub) => sum + hub.nodes.length, 0);
  if (totalPcs === 0) {
    if (!standalone) return null;
    return (
      <div className="relay-map-empty" data-map-empty="">
        <RadioTower className="relay-map-empty-icon" aria-hidden="true" />
        <p className="relay-map-empty-copy">{t("No relays in use yet.")}</p>
      </div>
    );
  }
  return <RelayMapFigure map={map} layout={layoutRelayMap(map)} selectedPcId={selectedPcId} {...(onSelectPc ? { onSelectPc } : {})} {...(onSelectRelay ? { onSelectRelay } : {})} />;
}

function RelayMapFigure({ map, layout, selectedPcId, onSelectPc, onSelectRelay }: {
  readonly map: RelayMapModel;
  readonly layout: RelayMapLayout | null;
  readonly selectedPcId: string | null;
  readonly onSelectPc?: (serverId: string) => void;
  readonly onSelectRelay?: (origin: string) => void;
}) {
  const t = useT();
  const svg = useRef<SVGSVGElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const node = svg.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(([entry]) => setPaused(entry !== undefined && !entry.isIntersecting));
    watch.observe(node);
    return () => watch.disconnect();
  }, [layout]);

  const nodes = map.hubs.flatMap((hub) => hub.nodes);
  const dotStates = new Set(nodes.map(nodeStatusDotState));
  const hasLiveWire = nodes.some((node) => nodeWireState(node) === "live");
  const hasUnchecked = nodes.some((node) => node.state === "unchecked" && node.check === null);
  const summary = t("Connection map: {me}. Relays: {relays}. PCs: {pcs}. Seen lately: {lately}. Ready: {ready}. Needs you: {needsYou}. Offline: {offline}.", {
    me: map.me.label,
    relays: map.hubs.map((hub) => relayHost(hub.origin)).join(", "),
    pcs: nodes.length,
    lately: nodes.filter((node) => node.seen === "lately").length,
    ready: nodes.filter((node) => node.state === "paired").length,
    needsYou: nodes.filter((node) => inDashboardFilter(node.state, "needs")).length,
    offline: nodes.filter((node) => node.state === "offline").length,
  });

  const legendItems: { readonly key: string; readonly dot?: StatusDotState; readonly wire?: WireState; readonly label: string }[] = [
    ...(hasLiveWire ? [{ key: "lately", wire: "live" as const, label: t("Seen lately") }] : []),
    ...(dotStates.has("ready") ? [{ key: "ready", dot: "ready" as const, label: t("Ready") }] : []),
    ...(dotStates.has("needs-you") ? [{ key: "needs-you", dot: "needs-you" as const, label: t("Needs you") }] : []),
    ...(dotStates.has("checking") ? [{ key: "checking", dot: "checking" as const, label: t("Checking…") }] : []),
    ...(hasUnchecked ? [{ key: "unchecked", dot: "offline" as const, label: t("Paired · not checked") }] : []),
    ...(nodes.some((node) => node.state === "offline") ? [{ key: "offline", dot: "offline" as const, label: t("Machine offline") }] : []),
    ...(dotStates.has("failed") ? [{ key: "unreachable", dot: "failed" as const, label: t("Could not reach this machine") }] : []),
  ];

  const checkingWires = checkingWirePaths(map, layout);
  const pos = (x: number, y: number, w: number, h: number) => ({ left: `${(x / w) * 100}%`, top: `${(y / h) * 100}%` });

  return (
    <figure className="relay-map" data-diagram={layout !== null ? "true" : "false"}>
      <figcaption className="relay-map-head">
        <div className="relay-map-title-group">
          <span className="relay-map-heading">{t("Connection map")}</span>
          <small className="relay-map-security"><Lock aria-hidden="true" /><span>{t("sees sizes, not content")}</span></small>
        </div>
        {legendItems.length > 0 && (
          <ul className="relay-map-legend" aria-hidden="true">
            {legendItems.map((item) => (
              <li key={item.key} data-legend-key={item.key}>
                {item.wire !== undefined ? <span className="relay-map-wire-swatch" data-wire={item.wire} aria-hidden="true" /> : <StatusDot state={item.dot ?? "offline"} />}
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        )}
      </figcaption>

      {layout !== null && (
        <div className="relay-map-diagram">
          <svg ref={svg} className="relay-map-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={summary} aria-hidden="true" focusable="false" data-paused={paused ? "" : undefined}>
            {layout.hubs.map((hub) => (
              <path key={hub.origin} className="relay-map-edge" data-wire={hubWireState(hubRoutedNodes(map.hubs[hub.hub] ?? { origin: hub.origin, nodes: [] }))} data-hub={hub.origin} d={wire(layout.me, hub)} />
            ))}
            {layout.pcs.flatMap((pc) => {
              const from = pc.via === "direct" ? layout.me : layout.hubs[pc.hub];
              return from ? [<path key={pc.node.server_id} className="relay-map-edge" data-wire={nodeWireState(pc.node)} data-pc={pc.node.server_id} d={wire(from, pc)} data-via={pc.via} />] : [];
            })}
            {checkingWires.map((d, i) => <path key={i} className="relay-map-flow" d={d} />)}
          </svg>

          <div className="relay-map-nodes" aria-hidden="true">
            <div className="relay-map-me-card" style={pos(layout.me.x, layout.me.y, layout.width, layout.height)} data-me="" title={map.me.label}>
              <span className="relay-map-me-mark"><MonitorSmartphone aria-hidden="true" /></span>
              <span className="relay-map-me-label">{clip(map.me.label)}</span>
            </div>

            {layout.hubs.map((hub) => {
              const host = relayHost(hub.origin);
              const countText = hub.pcCount === 1 ? t("1 PC") : t("{count} PCs", { count: hub.pcCount });
              const scopeText = hub.regional ? t("regional") : t("global");
              const hsText = hub.handshake !== null ? `${t("Fastest PC handshake")} · ${t("{n} ms", { n: hub.handshake.rttMs })}` : null;
              return (
                <button key={hub.origin} type="button" className="relay-map-hub-btn" style={pos(hub.x, hub.y, layout.width, layout.height)} tabIndex={-1} data-hub={hub.origin} title={`${host} · ${countText} · ${scopeText}${hsText !== null && hub.handshake !== null ? ` · ${hsText} (${hub.handshake.pcName})` : ""}`} onClick={() => activateRelay(hub.origin, onSelectRelay)}>
                  <span className="relay-map-hub-mark"><RadioTower aria-hidden="true" /></span>
                  <span className="relay-map-hub-body">
                    <span className="pill relay-map-host">{host}</span>
                    <span className="relay-map-hub-meta">
                      {countText} · {scopeText}
                      {hsText !== null && <> · <span className="relay-map-rtt">{hsText}</span></>}
                    </span>
                  </span>
                </button>
              );
            })}

            {layout.pcs.map((pc) => {
              const detailWord = mapStateDetail(pc.node, t);
              return (
                <button key={pc.node.server_id} type="button" className="relay-map-pc-btn" style={pos(pc.x, pc.y, layout.width, layout.height)} tabIndex={-1} data-pc-node={pc.node.server_id} data-pc-state={pc.node.state} data-seen={pc.node.seen} data-selected={selectedPcId === pc.node.server_id ? "" : undefined} title={`${pc.node.name} · ${detailWord} · ${seenTitleOf(pc.node, t)}`} onClick={() => activatePc(pc.node.server_id, onSelectPc)}>
                  <StatusDot state={nodeStatusDotState(pc.node)} />
                  <span className="relay-map-pc-body">
                    <span className="relay-map-name">{clip(pc.node.name)}</span>
                    <span className="relay-map-word">{mapStateWord(pc.node, t)}</span>
                  </span>
                  <NodeTooltip node={pc.node} detail={detailWord} t={t} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <ol className="relay-map-routes" aria-label={t("Relays")}>
        <li className="relay-map-origin">
          <div className="relay-map-hop" data-me="">
            <span className="relay-map-hop-mark"><MonitorSmartphone aria-hidden="true" /></span>
            <span className="relay-map-hop-name" title={map.me.label}>{map.me.label}</span>
          </div>
        </li>
        {nodes.filter(isDirectRoute).map((node) => (
          <li key={node.server_id} className="relay-map-route" data-route="direct">
            <div className="relay-map-link" data-wire={nodeWireState(node)} data-live="" aria-hidden="true" />
            <div className="relay-map-hop" data-pc-state={node.state} data-seen={node.seen}><PcHop node={node} selected={selectedPcId === node.server_id} {...(onSelectPc ? { onSelectPc } : {})} t={t} /></div>
          </li>
        ))}
        {map.hubs.map((hub) => {
          const host = relayHost(hub.origin);
          const scopeText = isRegionalRelay(hub.origin) ? t("regional") : t("global");
          const countText = hub.nodes.length === 1 ? t("1 PC") : t("{count} PCs", { count: hub.nodes.length });
          const hs = relayHandshake(hub);
          const hsText = hs !== null ? `${t("Fastest PC handshake")} · ${t("{n} ms", { n: hs.rttMs })}` : null;
          const routedNodes = hubRoutedNodes(hub);
          const linkWire = hubWireState(routedNodes);
          return (
            <li key={hub.origin} className="relay-map-route">
              <div className="relay-map-link" data-wire={linkWire} data-live={linkWire === "live" ? "" : undefined} aria-hidden="true" />
              <div className="relay-map-hop relay-map-hop-hub">
                <button type="button" className="relay-map-hop-btn relay-map-hop-hub-btn" data-relay-origin={hub.origin} title={`${host} · ${countText} · ${scopeText}${hsText !== null && hs !== null ? ` · ${hsText} (${hs.pcName})` : ""}`} onClick={() => activateRelay(hub.origin, onSelectRelay)}>
                  <span className="relay-map-hop-mark relay-map-hop-hub-mark"><RadioTower aria-hidden="true" /></span>
                  <span className="relay-map-hop-hub-body">
                    <span className="pill relay-map-host">{host}</span>
                    <small className="relay-map-hop-meta">
                      <span>{countText}</span><span>·</span><span>{scopeText}</span>
                      {hsText !== null && <><span>·</span><span className="relay-map-rtt">{hsText}</span></>}
                    </small>
                  </span>
                </button>
              </div>
              {routedNodes.length > 0 && (
                <ul className="relay-map-fan">
                  {routedNodes.map((node) => <li key={node.server_id} className="relay-map-hop" data-pc-state={node.state} data-seen={node.seen}><PcHop node={node} selected={selectedPcId === node.server_id} {...(onSelectPc ? { onSelectPc } : {})} t={t} /></li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
