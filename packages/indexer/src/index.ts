// indexer: sumdb に記録された版を、pkgs.emela.dev の索引（pkgs-api の D1）に写す。
//
// Cron で起き、前回読んだところ（index_progress）から checkpoint の大きさまで、entries tile の記録を
// 読む。版の commit と時刻は proxy の `.info` から、要求する emela，license，root 名，依存は `.toml`
// から取る。版を写すたびに、その Pome の pomes の行を最新版に合わせ、importers を数え直す。
//
// proxy は「sumdb に記録 → R2 → `.info`」の順に置くので、記録はあっても `.info` がまだない版がある。
// そこで止めて、次の Cron でその版から読み直す。記録の順に写すので、読んだところより前は全部写っている。

import {
  openNote,
  parseCheckpoint,
  parseRecord,
  parseVerifierKey,
  locationOf,
  proxyPaths,
  readEntryBundle,
  type SourcePath,
  type SumRecord,
  sumdbPaths,
  TILE_WIDTH,
  type VersionInfo,
} from "@pome-registry/protocol";
import { parse as parseToml } from "smol-toml";

// index_progress での sumdb の名前。
const LOG = "sumdb";

// 1回に写す記録の数。記録ごとに R2 を2回読むので、Worker の subrequest の上限より十分小さくする。
const BATCH = 100;

export type IndexResult = {
  readonly from: number;
  readonly to: number;
  readonly size: number;
  // `.info` がまだなくて止まった版。
  readonly waiting?: string;
};

export default {
  async scheduled(_controller, env): Promise<void> {
    const r = await index(env);
    if (r.waiting !== undefined) console.warn(`waiting for ${r.waiting} (${r.to}/${r.size})`);
    else if (r.to > r.from) console.log(`indexed ${r.from}..${r.to} of ${r.size}`);
  },
} satisfies ExportedHandler<Env>;

export async function index(env: Env, batch = BATCH): Promise<IndexResult> {
  const size = await checkpointSize(env);
  const from = await progress(env.DB);
  const records = await readRecords(env.SUMDB, from, Math.min(size, from + batch), size);

  const writes: D1PreparedStatement[] = [];
  const touched = new Set<string>();
  let to = from;
  let waiting: string | undefined;
  for (const record of records) {
    const row = await versionRow(env.PROXY, record);
    if (row === undefined) {
      waiting = `${record.path}@${record.version.raw}`;
      break;
    }
    writes.push(insertVersion(env.DB, row), ...insertDependencies(env.DB, row));
    touched.add(row.path);
    to++;
  }
  if (to > from) {
    const pomes = [...touched].map((path) => upsertPome(env.DB, path));
    await env.DB.batch([...writes, ...pomes, countImporters(env.DB), saveProgress(env.DB, to)]);
  }
  return waiting === undefined ? { from, to, size } : { from, to, size, waiting };
}

// 署名を確かめた checkpoint の大きさ。まだ何も記録がなければ 0。
async function checkpointSize(env: Env): Promise<number> {
  const object = await env.SUMDB.get(sumdbPaths.checkpoint());
  if (object === null) return 0;
  return parseCheckpoint(openNote(await object.text(), parseVerifierKey(env.SUMDB_VERIFIER_KEY))).size;
}

async function progress(db: D1Database): Promise<number> {
  const row = await db.prepare("select size from index_progress where name = ?").bind(LOG).first<{ size: number }>();
  return row?.size ?? 0;
}

function saveProgress(db: D1Database, size: number): D1PreparedStatement {
  return db
    .prepare("insert into index_progress (name, size) values (?, ?) on conflict (name) do update set size = excluded.size")
    .bind(LOG, size);
}

// 記録 [from, end) を、大きさ size の木の entries tile から読む。
export async function readRecords(bucket: R2Bucket, from: number, end: number, size: number): Promise<SumRecord[]> {
  const decoder = new TextDecoder();
  const records: SumRecord[] = [];
  for (let tile = Math.floor(from / TILE_WIDTH); tile * TILE_WIDTH < end; tile++) {
    // size に届いていない最後の tile は partial tile。
    const width = Math.min(TILE_WIDTH, size - tile * TILE_WIDTH);
    const key = sumdbPaths.entries(tile, width);
    const object = await bucket.get(key);
    if (object === null) throw new Error(`no entries tile ${key}`);
    const entries = readEntryBundle(new Uint8Array(await object.arrayBuffer()));
    if (entries.length !== width) throw new Error(`entries tile ${key} has ${entries.length} records`);
    const first = tile * TILE_WIDTH;
    for (let i = Math.max(from, first); i < Math.min(end, first + width); i++) {
      records.push(parseRecord(decoder.decode(entries[i - first])));
    }
  }
  return records;
}

type VersionRow = {
  readonly path: string;
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: string;
  readonly publishedAt: string;
  readonly emela: string;
  readonly license: string | undefined;
  readonly module: string;
  readonly dependencies: readonly Dependency[];
  readonly commit: string;
  readonly hash: string;
};

export type Dependency = { readonly path: string; readonly requirement: string };

// Pome.toml のうち、索引に写すもの。
export type Manifest = {
  // `[pome] emela`。書いていなければ空。
  readonly emela: string;
  // `[pome] license`。書いていないか、SPDX の式として読めなければ undefined。
  readonly license: string | undefined;
  // `[pome] module`。書いていなければ path の最後の segment を PascalCase にしたもの（4.7）。
  // それも作れなければ空。
  readonly module: string;
  // `[dependencies]` を source path の順に。
  readonly dependencies: readonly Dependency[];
};

// 記録の版の行。proxy にまだ `.info` か `.toml` がなければ undefined。
async function versionRow(bucket: R2Bucket, record: SumRecord): Promise<VersionRow | undefined> {
  const { path, version } = record;
  const [info, manifest] = await Promise.all([
    bucket.get(proxyPaths.info(path, version)),
    bucket.get(proxyPaths.manifest(path, version)),
  ]);
  if (info === null || manifest === null) return undefined;
  const { commit, time } = await info.json<VersionInfo>();
  const { emela, license, module, dependencies } = readManifest(path, await manifest.text());
  return {
    path,
    version: version.raw,
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    pre: version.prerelease.join("."),
    publishedAt: time,
    emela,
    license,
    module,
    dependencies,
    commit,
    hash: record.tree,
  };
}

// `path` の版の Pome.toml を読む。proxy が検査して取り込んだものなので TOML としては読める。
export function readManifest(path: SourcePath, manifest: string): Manifest {
  const toml = parseToml(manifest);
  const pome = table(toml["pome"]);
  const emela = pome["emela"];
  const license = pome["license"];
  const module = pome["module"];
  return {
    emela: typeof emela === "string" ? emela : "",
    license: typeof license === "string" && isLicenseExpression(license) ? license : undefined,
    module: typeof module === "string" ? module : defaultRootName(path),
    dependencies: dependenciesOf(table(toml["dependencies"])),
  };
}

function table(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// `"path" = "v1.0.0"` と `"path" = { version = "v1.0.0", module = "..." }` の両方の形。
function dependenciesOf(dependencies: Record<string, unknown>): Dependency[] {
  const found: Dependency[] = [];
  for (const [path, value] of Object.entries(dependencies)) {
    const requirement = typeof value === "string" ? value : table(value)["version"];
    if (typeof requirement === "string") found.push({ path, requirement });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// path の最後の segment（`/vN` は数えない）の `-` を `_` にして PascalCase にしたもの。コンパイラの
// `to_type_name` と同じく、小文字・数字・`_` だけの snake_case で、変換した結果が型の名前（大文字で
// 始まり、小文字を含む）になるときだけ作れる。作れなければ空。
export function defaultRootName(path: SourcePath): string {
  const last = locationOf(path).split("/").at(-1) ?? "";
  const name = last.replaceAll("-", "_");
  if (!/^[a-z0-9_]+$/.test(name) || name.split("_").some((w) => w === "")) return "";
  const converted = name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Z]/.test(converted) && /[a-z]/.test(converted) ? converted : "";
}

// SPDX の license expression（SPDX 仕様の附属書「SPDX License Expressions」）の構文に合うか。
// 識別子が SPDX License List にあるかは見ない（pome-license の提案に合わせる）。演算子は大文字だけ。
export function isLicenseExpression(text: string): boolean {
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const id = (t: string | undefined) => t !== undefined && /^(DocumentRef-[A-Za-z0-9.-]+:)?[A-Za-z0-9.-]+\+?$/.test(t) && !OPERATORS.has(t);
  const exception = (t: string | undefined) => t !== undefined && /^[A-Za-z0-9.-]+$/.test(t) && !OPERATORS.has(t);
  const simple = (): boolean => {
    if (tokens[i] === "(") {
      i++;
      if (!compound() || tokens[i] !== ")") return false;
      i++;
      return true;
    }
    if (!id(tokens[i])) return false;
    i++;
    if (tokens[i] === "WITH") {
      i++;
      if (!exception(tokens[i])) return false;
      i++;
    }
    return true;
  };
  const and = (): boolean => {
    if (!simple()) return false;
    while (tokens[i] === "AND") {
      i++;
      if (!simple()) return false;
    }
    return true;
  };
  const compound = (): boolean => {
    if (!and()) return false;
    while (tokens[i] === "OR") {
      i++;
      if (!and()) return false;
    }
    return true;
  };
  return tokens.length > 0 && compound() && i === tokens.length;
}

const OPERATORS = new Set(["AND", "OR", "WITH"]);

// 版の中身は変わらないので、読み直し（index_progress を戻したとき）では Pome.toml から取った値だけを
// 書き直す。前の indexer が写した行に license と module を埋めるのにも使う。
function insertVersion(db: D1Database, r: VersionRow): D1PreparedStatement {
  return db
    .prepare(
      `insert into pome_versions
         (path, version, major, minor, patch, pre, published_at, emela, license, module, commit_hash, hash)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (path, version) do update
         set emela = excluded.emela, license = excluded.license, module = excluded.module`,
    )
    .bind(
      r.path,
      r.version,
      r.major,
      r.minor,
      r.patch,
      r.pre,
      r.publishedAt,
      r.emela,
      r.license ?? null,
      r.module,
      r.commit,
      r.hash,
    );
}

function insertDependencies(db: D1Database, r: VersionRow): D1PreparedStatement[] {
  return r.dependencies.map((d) =>
    db
      .prepare(
        `insert into pome_dependencies (path, version, dependency, requirement)
         values (?, ?, ?, ?)
         on conflict (path, version, dependency) do nothing`,
      )
      .bind(r.path, r.version, d.path, d.requirement),
  );
}

// 版の並び。pkgs-api の `Pome.latest` と同じく、最新のリリース、なければ最新のプレリリースが先頭。
const LATEST_FIRST = "pre = '' desc, major desc, minor desc, patch desc, pre desc";

// `path` の pomes の行を、pome_versions にある最新版に合わせる。synopsis と symbols はまだ作らないので、
// 新しい行は空のまま、既にある行はそのまま残す。importers は countImporters が数える。
function upsertPome(db: D1Database, path: string): D1PreparedStatement {
  return db
    .prepare(
      `insert into pomes (path, module, version, synopsis, symbols, importers)
       select path, module, version, '', '', 0
       from pome_versions
       where path = ?
       order by ${LATEST_FIRST}
       limit 1
       on conflict (path) do update set module = excluded.module, version = excluded.version`,
    )
    .bind(path);
}

// 各 Pome の importers を、最新版がその Pome に依存している Pome の数にする。版が1つ増えると、その
// Pome の最新版が替わって前の依存先の数も変わるので、毎回全部を数え直す。
function countImporters(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `with latest as (
       select path, version, row_number() over (partition by path order by ${LATEST_FIRST}) as n
       from pome_versions
     ),
     counts as (
       select d.dependency as path, count(*) as n
       from pome_dependencies d
       join latest l on l.path = d.path and l.version = d.version and l.n = 1
       group by d.dependency
     )
     update pomes
     set importers = coalesce((select n from counts where counts.path = pomes.path), 0)
     where importers != coalesce((select n from counts where counts.path = pomes.path), 0)`,
  );
}
