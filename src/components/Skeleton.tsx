import "./Skeleton.css";

import type { SkeletonWidth } from "../lib/skeleton.ts";

export function Skeleton({ className, width }: { className?: string; width?: SkeletonWidth }) {
  return <span className={className === undefined ? "skeleton" : `skeleton ${className}`} data-width={width} aria-hidden="true" />;
}
