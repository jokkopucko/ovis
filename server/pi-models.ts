import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The context window a pi model runs in.
 *
 * A pi transcript records what a request filled but never the window it filled, so the
 * percentage the composer's ring shows cannot come from the file. pi answers it from its
 * own model registry, which lives in the process (`getBuiltinModel`, compiled into the
 * bundle) and is refreshed over the network, so a reader of the transcript cannot duplicate
 * it. What it can read are the catalogs pi does keep on disk:
 *
 *  - `models.json` — the user's custom providers (pi's default location, moved by
 *    `PI_CODING_AGENT_DIR`), the only file pi's own footer consults;
 *  - `commandcode-models.json` — the commandcode provider's cached catalog, which states a
 *    window for every model pi offers through it;
 *  - `models-store.json` — pi's store for the other providers it knows on disk, by provider
 *    id, each with the same flat `models` list.
 *
 * So this resolves what those files state and nothing else. A model pi knows only from its
 * built-in registry, a provider whose entry omits `contextWindow`, and a model that names none
 * while its provider states one (pi does not inherit that number) all stay unresolved and the
 * ring is not drawn: guessing a window would draw a percentage the user cannot tell from pi's
 * own. pi's footer does the same, showing `?` in place of a number.
 */

/** `models.json`'s own spelling: `providers` by id, each with a list of models. */
type PiModel = { id?: unknown; contextWindow?: unknown };
type PiProvider = { models?: unknown; modelOverrides?: unknown };
type PiCatalog = { providers?: Record<string, PiProvider> };

/** pi strips a BOM and `//` comments before parsing this file, so a commented file still loads. */
function parse(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, "").replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : "")).replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""));
  try { return JSON.parse(stripped); } catch { return null; }
}

/**
 * A `models.json` provider's models by id.
 *
 * A model's own `contextWindow`, or the `modelOverrides[model.id]` window when pi has one, and
 * nothing else. Two things this deliberately does not do, both checked against pi 0.87.1 by
 * pointing `PI_CODING_AGENT_DIR` at a crafted `models.json` and reading `pi --list-models`:
 *
 * - A provider-level `contextWindow` is NOT inherited by its models. A provider at 32000 whose
 *   model names no window shows that model at pi's own default of 128000, not at 32000. So this
 *   reports no window there: pi's default is pi's to apply, not a number this reader may show as
 *   though the user had stated it, and the ring stays undrawn rather than showing a denominator pi
 *   never used.
 * - `modelOverrides` IS applied, after the model definitions, and wins
 *   (`contextWindow: override.contextWindow ?? model.contextWindow`). Reading only `models` would
 *   report the pre-override window; at 128000 against an override of 256000 that is half the window
 *   and double the percentage the ring shows.
 *
 * An entry that is not an object is skipped rather than read, and the models beside it are still
 * resolved. pi is stricter: it validates the file, warns, and refuses the whole provider — checked
 * with a `models` list of `null, "a string", {id}`, which leaves `pi --list-models` reporting no
 * models at all. This reader is deliberately the more forgiving of the two, because its worst
 * outcome is one fewer number on the ring, while pi's worst outcome is switching to a model that
 * does not exist. It is not merely defensive: a `null` in that list threw, and the throw came from
 * the read every poll does, so the chat went down for a comma in a hand-edited file.
 */
function windowsFromModelsJson(provider: PiProvider): Map<string, number | null> {
  const list: unknown[] = Array.isArray(provider.models) ? provider.models : [];
  const overrides = (provider as { modelOverrides?: unknown }).modelOverrides;
  const models = new Map<string, number | null>();
  for (const value of list) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as PiModel;
    if (typeof model.id !== "string") continue;
    const listed = overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)
      ? (overrides as Record<string, unknown>)[model.id]
      : undefined;
    const override = listed !== null && typeof listed === "object" && !Array.isArray(listed) ? listed as PiModel : undefined;
    // pi's own rule, field by field: the override states a window or the model's own stands. An
    // override that only renames a model, or sets its cost, says nothing here
    const window = override?.contextWindow ?? model.contextWindow;
    // a model the user defined without a window stays unknown (null), so a later catalog's number
    // for the same id does not stand in for the definition pi runs
    models.set(model.id, typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null);
  }
  // pi applies an override to every model of the provider, built-in and store models included, so
  // an override's window stands for a model this file does not list too; one that states no window
  // leaves that model to the catalog that lists it
  if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [id, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (models.has(id) || value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const window = (value as PiModel).contextWindow;
      if (typeof window === "number" && Number.isFinite(window) && window > 0) models.set(id, window);
    }
  }
  return models;
}

/**
 * A flat list of `{ id, contextWindow }` entries, as pi's commandcode cache and model store keep
 * them. Same rules as above for a damaged entry or a window that is not a positive number.
 */
function windowsFromFlatList(list: unknown): Map<string, number> {
  const models = new Map<string, number>();
  if (!Array.isArray(list)) return models;
  for (const value of list) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as PiModel;
    if (typeof model.id !== "string") continue;
    const window = model.contextWindow;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
    models.set(model.id, window);
  }
  return models;
}

type Catalog = Map<string, Map<string, number | null>>;

/** pi's catalogs are short lists of models; a file past this is not one, and is not read whole. */
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/**
 * A regular file's text, or null. It opens non-blocking and checks the descriptor, so a FIFO
 * swapped in after the stat cannot hold the server's thread (a regular file ignores the flag).
 * Exported for the test that hands it that pipe.
 */
export function readRegularText(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_CATALOG_BYTES) + 1);
    let length = 0;
    for (let count = 1; count > 0 && length < buffer.length; length += count) count = readSync(fd, buffer, length, buffer.length - length, null);
    return length > stat.size ? null : buffer.subarray(0, length).toString("utf8");
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const cache = new Map<string, { signature: string; byProvider: Catalog | null }>();

function readCatalog(path: string, parseCatalog: (parsed: unknown) => Catalog | null): Catalog | null {
  let signature: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    // as catalogVersion reads it, so the chat's live cache and this one see the same edits
    signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return null; }
  const cached = cache.get(path);
  if (cached !== undefined && cached.signature === signature) return cached.byProvider;
  const text = readRegularText(path);
  if (text === null) return null;
  const parsed = parse(text);
  const byProvider = parsed === null ? null : parseCatalog(parsed);
  cache.set(path, { signature, byProvider });
  return byProvider;
}

function modelsJsonCatalog(parsed: unknown): Catalog | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const catalog = parsed as PiCatalog;
  if (catalog.providers === undefined || catalog.providers === null || typeof catalog.providers !== "object") return null;
  const byProvider: Catalog = new Map();
  for (const [id, provider] of Object.entries(catalog.providers)) {
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) continue;
    byProvider.set(id, windowsFromModelsJson(provider));
  }
  return byProvider;
}

function commandCodeCatalog(parsed: unknown): Catalog | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as { models?: unknown };
  if (!Array.isArray(record.models)) return null;
  const byProvider = new Map<string, Map<string, number>>();
  byProvider.set("commandcode", windowsFromFlatList(record.models));
  return byProvider;
}

function modelsStoreCatalog(parsed: unknown): Catalog | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const byProvider = new Map<string, Map<string, number>>();
  let found = false;
  for (const [id, value] of Object.entries(record)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = value as { models?: unknown };
    if (!Array.isArray(provider.models)) continue;
    byProvider.set(id, windowsFromFlatList(provider.models));
    found = true;
  }
  return found ? byProvider : null;
}

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env["PI_CODING_AGENT_DIR"];
  return typeof dir === "string" && dir.length > 0 ? (dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir) : join(homedir(), ".pi", "agent");
}

const CATALOGS: { name: string; parse: (p: unknown) => Catalog | null }[] = [
  { name: "models.json", parse: modelsJsonCatalog },
  { name: "commandcode-models.json", parse: commandCodeCatalog },
  { name: "models-store.json", parse: modelsStoreCatalog },
];

/**
 * A catalog file as it is now: a window resolved under another version may be another number. ctime
 * is in it because a chmod that makes the file readable again changes nothing else. A catalog that
 * cannot be stat'ed (a link loop, no permission) counts as absent, as readCatalog reads it.
 */
export function catalogVersion(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return "-"; }
}

export function piCatalogVersion(agentDir = piAgentDir()): string {
  return CATALOGS.map(({ name }) => catalogVersion(join(agentDir, name))).join("|");
}

/**
 * The window a model runs in, by the provider that served it. Both parts are asked for:
 * two providers can offer the same model id at different windows, and a session records
 * which of them answered. Consults every on-disk catalog pi keeps, in order.
 */
export function piContextWindow(model: string, provider: string | null, agentDir = piAgentDir()): number | null {
  for (const file of CATALOGS) {
    const catalog = readCatalog(join(agentDir, file.name), file.parse);
    if (catalog === null) continue;
    // an exact provider match only: a model id a second provider also serves, at another
    // window, must not borrow the first one's number
    const byId = provider === null ? undefined : catalog.get(provider);
    if (byId === undefined) continue;
    if (byId.has(model)) return byId.get(model) ?? null;
  }
  return null;
}

export function forgetPiModels(): void { cache.clear(); }
