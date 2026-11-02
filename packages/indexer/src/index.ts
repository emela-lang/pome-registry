// indexer: sumdb に記録された版を、pkgs.emela.dev の索引（pkgs-api の D1 の pome_versions）に写す。
//
// Cron で起き、前回読んだところ（index_progress）から checkpoint の大きさまで、entries tile の記録を
// 読む。版の commit と時刻は proxy の `.info` から、要求する emela は `.toml` から取る。
//
// proxy は「sumdb に記録 → R2 → `.info`」の順に置くので、記録はあっても `.info` がまだない版がある。
// そこで止めて、次の Cron でその版から読み直す。記録の順に写すので、読んだところより前は全部写っている。

import {
  openNote,
  parseCheckpoint,
  parseRecord,
  parseVerifierKey,
  proxyPaths,
  readEntryBundle,
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
  let to = from;
  let waiting: string | undefined;
  for (const record of records) {
    const row = await versionRow(env.PROXY, record);
    if (row === undefined) {
      waiting = `${record.path}@${record.version.raw}`;
      break;
    }
    writes.push(insertVersion(env.DB, row));
    to++;
  }
  if (to > from) await env.DB.batch([...writes, saveProgress(env.DB, to)]);
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
  readonly commit: string;
  readonly hash: string;
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
  return {
    path,
    version: version.raw,
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    pre: version.prerelease.join("."),
    publishedAt: time,
    emela: emelaOf(await manifest.text()),
    commit,
    hash: record.tree,
  };
}

// Pome.toml の `[pome] emela`。書いていなければ空。
export function emelaOf(manifest: string): string {
  const pome = parseToml(manifest)["pome"];
  if (typeof pome !== "object" || pome === null || Array.isArray(pome)) return "";
  const emela = (pome as Record<string, unknown>)["emela"];
  return typeof emela === "string" ? emela : "";
}

// 同じ版の記録は sumdb に1つしかないので、2度目（読み直し）は何もしない。
function insertVersion(db: D1Database, r: VersionRow): D1PreparedStatement {
  return db
    .prepare(
      `insert into pome_versions
         (path, version, major, minor, patch, pre, published_at, emela, commit_hash, hash)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (path, version) do nothing`,
    )
    .bind(r.path, r.version, r.major, r.minor, r.patch, r.pre, r.publishedAt, r.emela, r.commit, r.hash);
}
