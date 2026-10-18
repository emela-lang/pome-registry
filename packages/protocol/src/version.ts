// version は git の tag で、semver に `v` を付けた形（4.7）。build metadata は持たない。

export type Version = {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
};

const NUM = "(0|[1-9][0-9]*)";
const IDENT = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?$`);

export class InvalidVersion extends Error {
  constructor(readonly input: string) {
    super(`invalid version \`${input}\`: expected a semver tag such as \`v1.2.3\``);
  }
}

export function parseVersion(input: string): Version {
  const m = VERSION.exec(input);
  if (m === null) throw new InvalidVersion(input);
  const toInt = (s: string | undefined) => {
    const n = Number(s);
    if (!Number.isSafeInteger(n)) throw new InvalidVersion(input);
    return n;
  };
  return {
    raw: input,
    major: toInt(m[1]),
    minor: toInt(m[2]),
    patch: toInt(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split("."),
  };
}

export function isVersion(input: string): boolean {
  return VERSION.test(input);
}

// semver の優先順位。負なら a が古い。
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// `@v/list` から `@latest` を選ぶ。prerelease でない最大を優先する。
export function latestVersion(versions: readonly Version[]): Version | undefined {
  const releases = versions.filter((v) => v.prerelease.length === 0);
  const pool = releases.length > 0 ? releases : versions;
  return pool.reduce<Version | undefined>(
    (best, v) => (best === undefined || compareVersions(v, best) > 0 ? v : best),
    undefined,
  );
}
