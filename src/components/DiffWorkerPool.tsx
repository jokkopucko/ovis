import { useEffect, type ReactNode } from "react";
import { WorkerPoolContext } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";

import { createIdleLease } from "../lib/idleLease.ts";
import { HIGHLIGHTER_OPTIONS, POOL_OPTIONS } from "../lib/sourceTheme.ts";

const IDLE_MS = 30_000;

const pool = createIdleLease(
  () => new WorkerPoolManager(POOL_OPTIONS, HIGHLIGHTER_OPTIONS),
  (manager) => { manager.terminate(); },
  IDLE_MS,
);

export function DiffWorkerPool({ children }: { children: ReactNode }) {
  const manager = pool.get();
  useEffect(() => pool.hold(), [manager]);
  return <WorkerPoolContext value={manager}>{children}</WorkerPoolContext>;
}
