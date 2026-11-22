import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_FAILURE_LENGTH = 2_000;
const SCREENSHOT_TIMEOUT_MS = 5_000;
const TRACE_TIMEOUT_MS = 15_000;
let nextSessionId = 0;

export interface BrowserEvidencePage {
  onConsole(listener: (type: string, text: string) => void): void;
  onPageError(listener: (message: string) => void): void;
  isOpen(): boolean;
  screenshot(path: string, timeoutMs: number): Promise<void>;
}

export interface BrowserEvidenceTracing {
  start(options: { screenshots: true; snapshots: false; sources: false }): Promise<void>;
  stop(path?: string): Promise<void>;
}

export interface BrowserEvidenceFiles {
  mkdir(path: string, mode: 0o700): Promise<void>;
  writeFile(path: string, content: string, mode: 0o600): Promise<void>;
  chmod(path: string, mode: 0o600): Promise<void>;
}

export interface BrowserEvidenceOptions {
  page: BrowserEvidencePage;
  tracing?: BrowserEvidenceTracing;
  directory?: string;
  script: string;
  scenario: string;
  trace?: boolean;
  files?: BrowserEvidenceFiles;
}

export interface BrowserEvidenceResult {
  files: string[];
  errors: string[];
}

export interface BrowserEvidenceSession {
  isOpen(): boolean;
  captureFailure(error: unknown): Promise<BrowserEvidenceResult>;
  finish(): Promise<void>;
}

const defaultFiles: BrowserEvidenceFiles = {
  mkdir: async (path, mode) => { await mkdir(path, { recursive: true, mode }); },
  writeFile: async (path, content, mode) => { await writeFile(path, content, { mode }); },
  chmod: async (path, mode) => { await chmod(path, mode); },
};

const limited = (value: string, max: number): string => value.slice(0, max);
const safePart = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "browser";

const failureOf = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error) return { name: limited(error.name || "Error", 100), message: limited(error.message, MAX_FAILURE_LENGTH) };
  return { name: typeof error, message: limited(String(error), MAX_FAILURE_LENGTH) };
};

class EvidenceTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "EvidenceTimeoutError";
  }
}

const withTimeout = async <T>(operation: Promise<T>, name: string, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EvidenceTimeoutError(name, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Trace snapshots/network are deliberately off. */
export async function startBrowserEvidence(options: BrowserEvidenceOptions): Promise<BrowserEvidenceSession> {
  const directory = options.directory;
  const enabled = directory !== undefined && directory.length > 0;
  const files = options.files ?? defaultFiles;
  const stem = `${safePart(options.script)}-${safePart(options.scenario)}`.slice(0, 128);
  const outputDirectory = enabled ? join(directory, `${stem}-${process.pid}-${++nextSessionId}`) : undefined;
  const messages: Array<{ type: string; message: string }> = [];
  const pendingErrors: string[] = [];
  let truncated = false;
  let finished = false;
  let traceStarted = false;

  const record = (type: string, message: string): void => {
    if (!enabled) return;
    if (messages.length >= MAX_MESSAGES) {
      messages.shift();
      truncated = true;
    }
    if (message.length > MAX_MESSAGE_LENGTH) truncated = true;
    messages.push({ type: limited(type, 80), message: limited(message, MAX_MESSAGE_LENGTH) });
  };

  if (enabled) {
    options.page.onConsole((type, text) => record(`console:${type}`, text));
    options.page.onPageError((message) => record("pageerror", message));
    if (options.trace && options.tracing) {
      const tracing = options.tracing;
      let startOperation: Promise<void> | undefined;
      try {
        startOperation = tracing.start({ screenshots: true, snapshots: false, sources: false });
        await withTimeout(startOperation, "trace start", TRACE_TIMEOUT_MS);
        traceStarted = true;
      } catch (error) {
        pendingErrors.push(`trace start: ${failureOf(error).message}`);
        if (startOperation && error instanceof EvidenceTimeoutError) {
          void startOperation.then(async () => {
            try {
              await withTimeout(tracing.stop(), "trace cleanup", TRACE_TIMEOUT_MS);
            } catch {}
          }).catch(() => {});
        }
      }
    }
  }

  const stopTrace = async (path?: string): Promise<void> => {
    if (!traceStarted || !options.tracing) return;
    traceStarted = false;
    const stopOperation = options.tracing.stop(path);
    try {
      await withTimeout(stopOperation, "trace stop", TRACE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof EvidenceTimeoutError && path !== undefined) {
        void stopOperation.then(() => files.chmod(path, 0o600)).catch(() => {});
      }
      throw error;
    }
  };

  const screenshotWithTimeout = async (path: string): Promise<void> => {
    const screenshotOperation = options.page.screenshot(path, SCREENSHOT_TIMEOUT_MS);
    try {
      await withTimeout(screenshotOperation, "screenshot", SCREENSHOT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof EvidenceTimeoutError) {
        void screenshotOperation.then(() => files.chmod(path, 0o600)).catch(() => {});
      }
      throw error;
    }
  };

  return {
    isOpen: () => options.page.isOpen(),
    captureFailure: async (error) => {
      if (finished) return { files: [], errors: [] };
      finished = true;
      const result: BrowserEvidenceResult = { files: [], errors: pendingErrors.splice(0) };
      if (!enabled) {
        try { await stopTrace(); } catch (stopError) { result.errors.push(`trace discard: ${failureOf(stopError).message}`); }
        return result;
      }

      try {
        await files.mkdir(outputDirectory!, 0o700);
      } catch (mkdirError) {
        result.errors.push(`directory: ${failureOf(mkdirError).message}`);
        try { await stopTrace(); } catch (stopError) { result.errors.push(`trace discard: ${failureOf(stopError).message}`); }
        return result;
      }

      const screenshot = join(outputDirectory!, `${stem}.png`);
      if (options.page.isOpen()) {
        try {
          await screenshotWithTimeout(screenshot);
          await files.chmod(screenshot, 0o600);
          result.files.push(screenshot);
        } catch (screenshotError) {
          result.errors.push(`screenshot: ${failureOf(screenshotError).message}`);
        }
      } else {
        result.errors.push("screenshot: page was already closed");
      }

      let trace: string | null = null;
      if (traceStarted) {
        const tracePath = join(outputDirectory!, `${stem}.trace.zip`);
        try {
          await stopTrace(tracePath);
          await files.chmod(tracePath, 0o600);
          trace = tracePath;
          result.files.push(tracePath);
        } catch (traceError) {
          result.errors.push(`trace: ${failureOf(traceError).message}`);
        }
      }

      const metadataPath = join(outputDirectory!, `${stem}.json`);
      const metadata = {
        script: options.script,
        scenario: options.scenario,
        failedAt: new Date().toISOString(),
        failure: failureOf(error),
        messages,
        messagesTruncated: truncated,
        artifacts: { screenshot: result.files.includes(screenshot) ? screenshot : null, trace },
        artifactErrors: result.errors,
      };
      try {
        await files.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
        await files.chmod(metadataPath, 0o600);
        result.files.push(metadataPath);
      } catch (metadataError) {
        result.errors.push(`metadata: ${failureOf(metadataError).message}`);
      }
      return result;
    },
    finish: async () => {
      if (finished) return;
      finished = true;
      try { await stopTrace(); } catch {}
    },
  };
}

export function browserEvidencePage(page: Page): BrowserEvidencePage {
  return {
    onConsole: (listener) => { page.on("console", (message) => listener(message.type(), message.text())); },
    onPageError: (listener) => { page.on("pageerror", (error) => listener(error.message)); },
    isOpen: () => !page.isClosed(),
    screenshot: async (path, timeout) => { await page.screenshot({ path, timeout }); },
  };
}

export function browserEvidenceTracing(context: BrowserContext): BrowserEvidenceTracing {
  return {
    start: async (options) => { await context.tracing.start(options); },
    stop: async (path) => { await context.tracing.stop(path === undefined ? undefined : { path }); },
  };
}
