/**
 * The update feed's files for one release. Each Mac build runs on its own CPU and writes its own
 * latest-mac.yml, while electron-updater reads one latest-mac.yml for both and picks the files
 * whose names say arm64 (or not), so the release carries the two merged. The Linux builds already
 * write one file each (latest-linux.yml, latest-linux-arm64.yml).
 */
interface FeedFile {
  url: string;
  sha512: string;
  size?: number;
  [key: string]: unknown;
}

interface Feed {
  version: string;
  files: FeedFile[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isFeedFile = (value: unknown): value is FeedFile => isRecord(value) && typeof value["url"] === "string" && typeof value["sha512"] === "string";
const isFeed = (value: unknown): value is Feed =>
  isRecord(value) && typeof value["version"] === "string" && Array.isArray(value["files"]) && value["files"].length > 0 && value["files"].every(isFeedFile);

function read(text: string, name: string): Feed {
  const feed: unknown = Bun.YAML.parse(text);
  if (!isFeed(feed)) throw new Error(`${name} is not an update feed (no version, or a file without url and sha512)`);
  return feed;
}

/**
 * One latest-mac.yml from each Mac build's: the same version, every file once. The top-level
 * path and sha512 (read only by old updaters) stay the first feed's. Written as JSON, which is
 * YAML too, so no value (a date, a version) changes type on the way back.
 */
export function mergeFeeds(feeds: { name: string; text: string }[]): string {
  if (feeds.length === 0) throw new Error("No update feeds to merge");
  const parsed = feeds.map(({ name, text }) => read(text, name));
  const [first] = parsed as [Feed, ...Feed[]];
  const files = new Map<string, FeedFile>();
  for (const [index, feed] of parsed.entries()) {
    if (feed.version !== first.version) throw new Error(`${feeds[index]!.name} is for ${feed.version}, not ${first.version}`);
    for (const file of feed.files) {
      const known = files.get(file.url);
      if (known && known.sha512 !== file.sha512) throw new Error(`${file.url} has two different hashes`);
      files.set(file.url, file);
    }
  }
  const releaseDate = parsed.map((feed) => feed.releaseDate).filter((date): date is string => typeof date === "string").sort().at(-1);
  return `${JSON.stringify({ ...first, files: [...files.values()], ...(releaseDate ? { releaseDate } : {}) }, null, 2)}\n`;
}
