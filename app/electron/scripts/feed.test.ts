import { describe, expect, it } from "bun:test";
import { mergeFeeds } from "./feed.ts";

const feed = (arch: string, date: string, version = "0.5.0") => `version: ${version}
files:
  - url: Ovis-${version}-${arch}.zip
    sha512: zip-${arch}==
    size: 100
  - url: Ovis-${version}-${arch}.dmg
    sha512: dmg-${arch}==
    size: 200
path: Ovis-${version}-${arch}.zip
sha512: zip-${arch}==
releaseDate: '${date}'
`;

describe("mergeFeeds", () => {
  it("lists both Macs' files in one feed that still reads as YAML, with the later date", () => {
    const merged = Bun.YAML.parse(mergeFeeds([
      { name: "x64", text: feed("x64", "2026-11-05T01:00:00.000Z") },
      { name: "arm64", text: feed("arm64", "2026-11-05T02:00:00.000Z") },
    ])) as { version: string; files: { url: string }[]; path: string; releaseDate: string };
    expect(merged.version).toBe("0.5.0");
    expect(merged.files.map((file) => file.url)).toEqual(["Ovis-0.5.0-x64.zip", "Ovis-0.5.0-x64.dmg", "Ovis-0.5.0-arm64.zip", "Ovis-0.5.0-arm64.dmg"]);
    expect(merged.path).toBe("Ovis-0.5.0-x64.zip");
    expect(merged.releaseDate).toBe("2026-11-05T02:00:00.000Z");
  });

  it("refuses feeds for two versions", () => {
    expect(() => mergeFeeds([{ name: "a", text: feed("x64", "2026-11-05T01:00:00.000Z") }, { name: "b", text: feed("arm64", "2026-11-05T01:00:00.000Z", "0.4.22") }])).toThrow(/b is for 0.4.22, not 0.5.0/);
  });

  it("refuses one file with two hashes", () => {
    const other = feed("x64", "2026-11-05T01:00:00.000Z").replace("zip-x64==\n    size", "changed==\n    size");
    expect(() => mergeFeeds([{ name: "a", text: feed("x64", "2026-11-05T01:00:00.000Z") }, { name: "b", text: other }])).toThrow(/two different hashes/);
  });

  it("refuses a file that is not a feed", () => {
    expect(() => mergeFeeds([{ name: "empty.yml", text: "" }])).toThrow(/empty.yml is not an update feed/);
  });
});
