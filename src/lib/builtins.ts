/**
 * The built-ins the app calls that are newer than the oldest Safari it runs on, filled in where the
 * browser lacks them (#2513). That Safari is 16.4: the app's regular expressions look behind,
 * which no earlier one parses, so an iPhone 8 or X (capped at iOS 16) runs the app from iOS 16.4.
 * Imported first by main.tsx, before any module that may call one as it loads. A real module, not
 * an inline script: the Content-Security-Policy allows only the app's own files.
 */

const define = (owner: object, name: string, value: unknown): void => {
  if (name in owner) return;
  Object.defineProperty(owner, name, { value, writable: true, configurable: true, enumerable: false });
};

// Safari 17.4
define(Promise, "withResolvers", function withResolvers<T>(this: PromiseConstructor) {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new this<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
});

// Safari 17.4
if (typeof AbortSignal !== "undefined") {
  define(AbortSignal, "any", (signals: Iterable<AbortSignal>): AbortSignal => {
    const controller = new AbortController();
    const all = [...signals];
    const done = all.find((signal) => signal.aborted);
    if (done) {
      controller.abort(done.reason);
      return controller.signal;
    }
    const end = (event: Event): void => {
      for (const signal of all) signal.removeEventListener("abort", end);
      controller.abort((event.target as AbortSignal).reason);
    };
    for (const signal of all) signal.addEventListener("abort", end);
    return controller.signal;
  });
}

// never on a plain-http address (not a secure context), whatever the browser; getRandomValues is
if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
  define(crypto, "randomUUID", (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}

export {};
