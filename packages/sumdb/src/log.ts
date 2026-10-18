// sumdb の Log。木の状態を SQLite に持つ、ただ1つの Durable Object。
//
// 透明性ログは1本の列なので、書き手は1つにする。追記は取り込みのたびにしか起きず、
// 読みは R2 から返すので、ここが詰まることはない。
//
// append は SQLite だけで完結させ、await を挟まない（ほかの追記に割り込ませない）。
// R2 への公開は後から追いかける。公開は SQLite の状態から何度でもやり直せるので、
// 途中で落ちても alarm で続きをやる。tile と lookup を先に、checkpoint を最後に置き、
// 読み手が tile のない checkpoint を見ないようにする。

import { DurableObject } from "cloudflare:workers";
import {
  type AppendResult,
  appendNodes,
  changedTiles,
  entryBundle,
  formatCheckpoint,
  type NodeReader,
  parseRecord,
  parseSignerKey,
  rootHash,
  signNote,
  type SumdbLog,
  sumdbPaths,
  TILE_WIDTH,
  tileData,
} from "@pome-registry/protocol";

const RETRY_MS = 30_000;
const IMMUTABLE = "public, max-age=31536000, immutable";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Log extends DurableObject<Env> implements SumdbLog {
  #publishing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS records (
          id      INTEGER PRIMARY KEY,
          path    TEXT NOT NULL,
          version TEXT NOT NULL,
          data    BLOB NOT NULL,
          UNIQUE (path, version)
        );
        CREATE TABLE IF NOT EXISTS nodes (
          level INTEGER NOT NULL,
          idx   INTEGER NOT NULL,
          hash  BLOB NOT NULL,
          PRIMARY KEY (level, idx)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS state (
          key   TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
      `);
    });
  }

  async append(text: string): Promise<AppendResult> {
    let record;
    try {
      record = parseRecord(text);
    } catch (e) {
      return { ok: false, error: "invalid_record", message: (e as Error).message };
    }
    const sql = this.ctx.storage.sql;
    const data = encoder.encode(text);

    const found = sql
      .exec<{ id: number; data: ArrayBuffer }>(
        "SELECT id, data FROM records WHERE path = ? AND version = ?",
        record.path,
        record.version.raw,
      )
      .toArray()[0];
    if (found !== undefined) {
      const recorded = decoder.decode(found.data);
      if (recorded !== text) return { ok: false, error: "conflict", recorded };
      return { ok: true, id: found.id, existing: true, published: this.#published() > found.id };
    }

    const id = this.#size();
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT INTO records (id, path, version, data) VALUES (?, ?, ?, ?)",
        id,
        record.path,
        record.version.raw,
        toArrayBuffer(data),
      );
      for (const n of appendNodes(id, data, this.#readNode)) {
        sql.exec("INSERT INTO nodes (level, idx, hash) VALUES (?, ?, ?)", n.level, n.index, toArrayBuffer(n.hash));
      }
    });

    const published = await this.publish().then(
      () => true,
      () => false,
    );
    return { ok: true, id, existing: false, published };
  }

  // 公開は1本だけ走らせる。走っている間に増えた記録は、同じ1本が続けて公開する。
  publish(): Promise<void> {
    this.#publishing ??= this.#publishLoop().finally(() => {
      this.#publishing = undefined;
    });
    return this.#publishing;
  }

  async alarm(): Promise<void> {
    await this.publish();
  }

  size(): number {
    return this.#size();
  }

  async #publishLoop(): Promise<void> {
    try {
      for (let from = this.#published(), to = this.#size(); from < to; from = this.#published(), to = this.#size()) {
        await this.#publishRange(from, to);
        this.ctx.storage.sql.exec(
          "INSERT INTO state (key, value) VALUES ('published', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          to,
        );
      }
    } catch (e) {
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      throw e;
    }
  }

  async #publishRange(from: number, to: number): Promise<void> {
    const signer = parseSignerKey(this.env.SUMDB_SIGNER_KEY);
    const checkpoint = signNote(
      formatCheckpoint({ origin: signer.name, size: to, root: rootHash(to, this.#readNode) }),
      signer,
    );
    const bucket = this.env.SUMDB;
    const puts: Promise<unknown>[] = [];

    for (const tile of changedTiles(from, to)) {
      const key = sumdbPaths.tile(tile.level, tile.index, tile.width);
      puts.push(bucket.put(key, tileData(tile, this.#readNode), { httpMetadata: binary() }));
      if (tile.level === 0) {
        const start = tile.index * TILE_WIDTH;
        const records = this.#records(start, start + tile.width).map((r) => new Uint8Array(r.data));
        puts.push(
          bucket.put(sumdbPaths.entries(tile.index, tile.width), entryBundle(records), { httpMetadata: binary() }),
        );
      }
    }
    for (const r of this.#records(from, to)) {
      const record = parseRecord(decoder.decode(r.data));
      // lookup の応答は「id、記録、署名済みの checkpoint」。
      const body = `${r.id}\n${decoder.decode(r.data)}\n${checkpoint}`;
      puts.push(
        bucket.put(sumdbPaths.lookup(record.path, record.version), body, { httpMetadata: text(IMMUTABLE) }),
      );
    }
    await Promise.all(puts);
    await bucket.put(sumdbPaths.checkpoint(), checkpoint, { httpMetadata: text("no-cache") });
  }

  #records(from: number, to: number): { id: number; data: ArrayBuffer }[] {
    return this.ctx.storage.sql
      .exec<{ id: number; data: ArrayBuffer }>(
        "SELECT id, data FROM records WHERE id >= ? AND id < ? ORDER BY id",
        from,
        to,
      )
      .toArray();
  }

  #size(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT coalesce(max(id) + 1, 0) AS n FROM records").one().n;
  }

  #published(): number {
    return (
      this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM state WHERE key = 'published'").toArray()[0]
        ?.value ?? 0
    );
  }

  #readNode: NodeReader = (level, index) => {
    const row = this.ctx.storage.sql
      .exec<{ hash: ArrayBuffer }>("SELECT hash FROM nodes WHERE level = ? AND idx = ?", level, index)
      .toArray()[0];
    if (row === undefined) throw new Error(`missing node ${level}/${index}`);
    return new Uint8Array(row.hash);
  };
}

function binary(): R2HTTPMetadata {
  return { contentType: "application/octet-stream", cacheControl: IMMUTABLE };
}

function text(cacheControl: string): R2HTTPMetadata {
  return { contentType: "text/plain; charset=utf-8", cacheControl };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
