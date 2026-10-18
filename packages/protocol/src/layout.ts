// proxy と sumdb の URL の並び。R2 のキーも同じ並びにする（静的ファイルとして配れるように）。

import { escapeSourcePath, type SourcePath } from "./source-path.ts";
import type { Version } from "./version.ts";

export const ARCHIVE_EXTENSION = ".tar.gz";

export const proxyPaths = {
  list: (p: SourcePath) => `${escapeSourcePath(p)}/@v/list`,
  latest: (p: SourcePath) => `${escapeSourcePath(p)}/@latest`,
  info: (p: SourcePath, v: Version) => `${escapeSourcePath(p)}/@v/${v.raw}.info`,
  manifest: (p: SourcePath, v: Version) => `${escapeSourcePath(p)}/@v/${v.raw}.toml`,
  archive: (p: SourcePath, v: Version) =>
    `${escapeSourcePath(p)}/@v/${v.raw}${ARCHIVE_EXTENSION}`,
} as const;

// sumdb の tile は C2SP tlog-tiles に従う。
//   tile/<L>/<N>[.p/<W>]、tile/entries/<N>[.p/<W>]
// N は3桁ずつに区切り、最後以外の区切りに `x` を付ける（1234067 → x001/x234/067）。
export const TILE_WIDTH = 256;

export const sumdbPaths = {
  checkpoint: () => "checkpoint",
  lookup: (p: SourcePath, v: Version) => `lookup/${escapeSourcePath(p)}@${v.raw}`,
  tile: (level: number, index: number, width = TILE_WIDTH) =>
    `tile/${level}/${tileIndex(index)}${partial(width)}`,
  entries: (index: number, width = TILE_WIDTH) =>
    `tile/entries/${tileIndex(index)}${partial(width)}`,
} as const;

export function tileIndex(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bad tile index ${n}`);
  const groups: string[] = [];
  let rest = n;
  do {
    groups.unshift(String(rest % 1000).padStart(3, "0"));
    rest = Math.floor(rest / 1000);
  } while (rest > 0);
  return groups.map((g, i) => (i < groups.length - 1 ? `x${g}` : g)).join("/");
}

function partial(width: number): string {
  if (!Number.isInteger(width) || width < 1 || width > TILE_WIDTH) {
    throw new RangeError(`bad tile width ${width}`);
  }
  return width === TILE_WIDTH ? "" : `.p/${width}`;
}

// sumdb の Log（Durable Object）の名前。ログは1本なので、名前も1つ。
export const SUMDB_LOG_NAME = "log";
