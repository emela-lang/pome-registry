import { env } from "cloudflare:workers";
import {
  entryBundle,
  formatCheckpoint,
  formatRecord,
  parseSignerKey,
  parseSourcePath,
  parseVersion,
  proxyPaths,
  signNote,
  sumdbPaths,
  TILE_WIDTH,
} from "@pome-registry/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { emelaOf, index } from "../src/index.ts";

// pkgs-api の migrations/ のうち、indexer が書く表。
const SCHEMA = [
  "drop table if exists pome_versions",
  "drop table if exists index_progress",
  `create table pome_versions (
     path text not null, version text not null,
     major integer not null, minor integer not null, patch integer not null,
     pre text not null default '', published_at text not null, emela text not null,
     commit_hash text not null, hash text not null,
     primary key (path, version))`,
  "create table index_progress (name text primary key, size integer not null)",
];

const H = (c: string) => `h1:${c.repeat(43)}=` as const;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

type Pome = { readonly path: string; readonly version: string };

// sumdb の Log が置くのと同じ並びで、records を記録した木の entries tile と checkpoint を置く。
async function record(pomes: readonly Pome[]): Promise<void> {
  const encoder = new TextEncoder();
  const data = pomes.map((p) =>
    encoder.encode(
      formatRecord({ path: parseSourcePath(p.path), version: parseVersion(p.version), tree: H("A"), manifest: H("B") }),
    ),
  );
  for (let tile = 0; tile * TILE_WIDTH < data.length; tile++) {
    const entries = data.slice(tile * TILE_WIDTH, (tile + 1) * TILE_WIDTH);
    await env.SUMDB.put(sumdbPaths.entries(tile, entries.length), entryBundle(entries));
  }
  const signer = parseSignerKey(env.TEST_SIGNER_KEY);
  const checkpoint = formatCheckpoint({ origin: signer.name, size: data.length, root: new Uint8Array(32) });
  await env.SUMDB.put(sumdbPaths.checkpoint(), signNote(checkpoint, signer));
}

// proxy が取り込みの最後に置く `.toml` と `.info`。
async function publish(p: Pome, emela = "0.26.0"): Promise<void> {
  const path = parseSourcePath(p.path);
  const version = parseVersion(p.version);
  await env.PROXY.put(proxyPaths.manifest(path, version), `[pome]\nname = "${p.path}"\nemela = "${emela}"\n`);
  await env.PROXY.put(
    proxyPaths.info(path, version),
    JSON.stringify({ version: p.version, commit: COMMIT, time: "2026-10-20T00:00:00Z" }),
  );
}

async function versions(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("select * from pome_versions order by path, version").all();
  return results;
}

beforeEach(async () => {
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  await env.SUMDB.delete(sumdbPaths.checkpoint());
});

describe("index", () => {
  it("copies the recorded versions into pome_versions", async () => {
    const pomes = [
      { path: "github.com/acme/a", version: "v1.2.3" },
      { path: "github.com/acme/a", version: "v1.3.0-alpha.1" },
    ];
    await record(pomes);
    for (const p of pomes) await publish(p);

    expect(await index(env)).toEqual({ from: 0, to: 2, size: 2 });
    expect(await versions()).toEqual([
      {
        path: "github.com/acme/a",
        version: "v1.2.3",
        major: 1,
        minor: 2,
        patch: 3,
        pre: "",
        published_at: "2026-10-20T00:00:00Z",
        emela: "0.26.0",
        commit_hash: COMMIT,
        hash: H("A"),
      },
      expect.objectContaining({ version: "v1.3.0-alpha.1", major: 1, minor: 3, patch: 0, pre: "alpha.1" }),
    ]);
  });

  it("does nothing before the sumdb records anything", async () => {
    expect(await index(env)).toEqual({ from: 0, to: 0, size: 0 });
  });

  it("starts where it stopped", async () => {
    const a = { path: "github.com/acme/a", version: "v1.0.0" };
    const b = { path: "github.com/acme/b", version: "v1.0.0" };
    await record([a]);
    await publish(a);
    expect(await index(env)).toEqual({ from: 0, to: 1, size: 1 });

    await record([a, b]);
    await publish(b);
    expect(await index(env)).toEqual({ from: 1, to: 2, size: 2 });
    expect((await versions()).map((v) => v.path)).toEqual(["github.com/acme/a", "github.com/acme/b"]);
  });

  it("waits for a version that the proxy has recorded but not yet published", async () => {
    // R2 はテストの間で残るので、ほかのテストで `.info` を置いていない path を使う。
    const a = { path: "github.com/acme/wait-a", version: "v1.0.0" };
    const b = { path: "github.com/acme/wait-b", version: "v1.0.0" };
    const c = { path: "github.com/acme/wait-c", version: "v1.0.0" };
    await record([a, b, c]);
    await publish(a);
    await publish(c);

    expect(await index(env)).toEqual({ from: 0, to: 1, size: 3, waiting: "github.com/acme/wait-b@v1.0.0" });
    expect((await versions()).map((v) => v.path)).toEqual(["github.com/acme/wait-a"]);

    await publish(b);
    expect(await index(env)).toEqual({ from: 1, to: 3, size: 3 });
  });

  it("reads a batch at a time, across tiles", async () => {
    const pomes = Array.from({ length: TILE_WIDTH + 4 }, (_, i) => ({
      path: `github.com/acme/p${i}`,
      version: "v1.0.0",
    }));
    await record(pomes);
    for (const p of pomes) await publish(p);

    expect(await index(env, TILE_WIDTH - 2)).toEqual({ from: 0, to: TILE_WIDTH - 2, size: TILE_WIDTH + 4 });
    expect(await index(env, TILE_WIDTH - 2)).toEqual({ from: TILE_WIDTH - 2, to: TILE_WIDTH + 4, size: TILE_WIDTH + 4 });
    expect(await versions()).toHaveLength(TILE_WIDTH + 4);
  });

  it("refuses a checkpoint that the sumdb did not sign", async () => {
    await env.SUMDB.put(sumdbPaths.checkpoint(), "sum.example.test\n1\nAAAA\n\n— other AAAA\n");
    await expect(index(env)).rejects.toThrow();
  });
});

describe("emelaOf", () => {
  it("reads the emela that Pome.toml requires", () => {
    expect(emelaOf('[pome]\nname = "github.com/acme/a"\nemela = "0.26.1"\n')).toBe("0.26.1");
  });

  it("is empty when Pome.toml says none", () => {
    expect(emelaOf('[pome]\nname = "github.com/acme/a"\n')).toBe("");
  });
});
