export function withinRetentionBudget(value: unknown, limit: number): boolean {
  let bytes = 0;
  const seen = new WeakSet<object>();
  function visit(v: unknown, depth: number): boolean {
    if (depth > 100) return false;
    if (typeof v === "string") bytes += 2 * v.length;
    else if (v && typeof v === "object") {
      if (seen.has(v)) return true;
      seen.add(v); bytes += 64;
      if (bytes > limit) return false;
      if (v instanceof Map) { for (const [key, item] of v) if (!visit(key, depth + 1) || !visit(item, depth + 1)) return false; }
      else { for (const [key, item] of Object.entries(v)) if (!visit(key, depth + 1) || !visit(item, depth + 1)) return false; }
    } else bytes += 8;
    return bytes <= limit;
  }
  return visit(value, 0);
}
