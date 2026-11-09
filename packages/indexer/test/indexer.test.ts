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
import { defaultRootName, index, isLicenseExpression, readManifest } from "../src/index.ts";

// pkgs-api の migrations/（0001 から 0004）のうち、indexer が書く表。pomes の全文検索の表と trigger も
// 写して、upsert が trigger を通っても壊れないことを確かめる。
const SCHEMA = [
  "drop table if exists pomes_fts",
  "drop table if exists pomes",
  "drop table if exists pome_versions",
  "drop table if exists pome_dependencies",
  "drop table if exists index_progress",
  `create table pomes (
     path text primary key, module text not null, version text not null,
     synopsis text not null, symbols text not null, importers integer not null default 0)`,
  `create virtual table pomes_fts using fts5(
     path, module, symbols, synopsis, content = 'pomes', tokenize = 'trigram')`,
  `create trigger pomes_ai after insert on pomes begin
     insert into pomes_fts (rowid, path, module, symbols, synopsis)
     values (new.rowid, new.path, new.module, new.symbols, new.synopsis);
   end`,
  `create trigger pomes_ad after delete on pomes begin
     insert into pomes_fts (pomes_fts, rowid, path, module, symbols, synopsis)
     values ('delete', old.rowid, old.path, old.module, old.symbols, old.synopsis);
   end`,
  `create trigger pomes_au after update on pomes begin
     insert into pomes_fts (pomes_fts, rowid, path, module, symbols, synopsis)
     values ('delete', old.rowid, old.path, old.module, old.symbols, old.synopsis);
     insert into pomes_fts (rowid, path, module, symbols, synopsis)
     values (new.rowid, new.path, new.module, new.symbols, new.synopsis);
   end`,
  `create table pome_versions (
     path text not null, version text not null,
     major integer not null, minor integer not null, patch integer not null,
     pre text not null default '', published_at text not null, emela text not null,
     commit_hash text not null, hash text not null, license text, module text not null default '',
     primary key (path, version))`,
  `create table pome_dependencies (
     path text not null, version text not null, dependency text not null, requirement text not null,
     primary key (path, version, dependency))`,
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

// proxy が取り込みの最後に置く `.toml` と `.info`。`extra` は `[pome]` の後ろに足す行。
async function publish(p: Pome, extra = ""): Promise<void> {
  const path = parseSourcePath(p.path);
  const version = parseVersion(p.version);
  await env.PROXY.put(
    proxyPaths.manifest(path, version),
    `[pome]\nname = "${p.path}"\nemela = "0.26.0"\n${extra}`,
  );
  await env.PROXY.put(
    proxyPaths.info(path, version),
    JSON.stringify({ version: p.version, commit: COMMIT, time: "2026-10-20T00:00:00Z" }),
  );
}

async function versions(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("select * from pome_versions order by path, version").all();
  return results;
}

async function pomes(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    "select path, module, version, synopsis, symbols, importers from pomes order by path",
  ).all();
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
        license: null,
        module: "",  // `A` は小文字を含まないので root 名にならない
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

describe("index into pomes", () => {
  it("keeps one row of each Pome at its latest version", async () => {
    // 記録の順と版の順は違う。プレリリースは最新のリリースより上に来ない。
    const pomes_ = [
      { path: "github.com/acme/kit", version: "v1.2.0" },
      { path: "github.com/acme/kit", version: "v1.3.0-beta.1" },
      { path: "github.com/acme/kit", version: "v1.1.0" },
      { path: "github.com/acme/edge", version: "v0.1.0-alpha.1" },
    ];
    await record(pomes_);
    for (const p of pomes_) await publish(p, 'module = "AcmeKit"\n');

    await index(env);
    expect(await pomes()).toEqual([
      { path: "github.com/acme/edge", module: "AcmeKit", version: "v0.1.0-alpha.1", synopsis: "", symbols: "", importers: 0 },
      { path: "github.com/acme/kit", module: "AcmeKit", version: "v1.2.0", synopsis: "", symbols: "", importers: 0 },
    ]);
  });

  it("moves the row to a newer version, keeping what it had", async () => {
    const old = { path: "github.com/acme/move", version: "v1.0.0" };
    const next = { path: "github.com/acme/move", version: "v1.1.0" };
    await record([old]);
    await publish(old);
    await index(env);
    await env.DB.prepare("update pomes set synopsis = 'kept' where path = ?").bind(old.path).run();

    await record([old, next]);
    await publish(next, 'module = "Moved"\n');
    await index(env);
    expect(await pomes()).toEqual([
      { path: old.path, module: "Moved", version: "v1.1.0", synopsis: "kept", symbols: "", importers: 0 },
    ]);
    // trigger が全文検索の表も書き換えている。
    const { results } = await env.DB.prepare(
      "select path from pomes_fts where pomes_fts match ?",
    ).bind('"Moved"').all();
    expect(results).toEqual([{ path: old.path }]);
  });

  it("writes the dependencies and counts only the latest version of each importer", async () => {
    const lib = { path: "github.com/acme/lib", version: "v1.0.0" };
    const old = { path: "github.com/acme/app", version: "v1.0.0" };
    const next = { path: "github.com/acme/app", version: "v2.0.0-rc.1" };
    const other = { path: "github.com/acme/tool", version: "v0.1.0" };
    await record([lib, old, next, other]);
    await publish(lib);
    await publish(old, `[dependencies]\n"github.com/acme/lib" = "v1.0.0"\n`);
    // プレリリースは最新ではないので、app の importers は old の依存で数える。
    await publish(next, `[dependencies]\n"github.com/acme/tool" = "v0.1.0"\n`);
    await publish(other, `[dependencies]\n"github.com/acme/lib" = { version = "v1.0.0", module = "L" }\n`);

    await index(env);
    const { results } = await env.DB.prepare(
      "select path, version, dependency, requirement from pome_dependencies order by path, version",
    ).all();
    expect(results).toEqual([
      { path: "github.com/acme/app", version: "v1.0.0", dependency: "github.com/acme/lib", requirement: "v1.0.0" },
      { path: "github.com/acme/app", version: "v2.0.0-rc.1", dependency: "github.com/acme/tool", requirement: "v0.1.0" },
      { path: "github.com/acme/tool", version: "v0.1.0", dependency: "github.com/acme/lib", requirement: "v1.0.0" },
    ]);
    expect((await pomes()).map((p) => [p.path, p.importers])).toEqual([
      ["github.com/acme/app", 0],
      ["github.com/acme/lib", 2],
      ["github.com/acme/tool", 0],
    ]);
  });

  it("fills license and module of rows written before, when read again", async () => {
    const a = { path: "github.com/acme/again", version: "v1.0.0" };
    await record([a]);
    await publish(a, 'license = "MIT"\n');
    await env.DB.prepare(
      `insert into pome_versions (path, version, major, minor, patch, pre, published_at, emela, commit_hash, hash)
       values (?, 'v1.0.0', 1, 0, 0, '', '2026-10-20T00:00:00Z', '0.26.0', ?, ?)`,
    ).bind(a.path, COMMIT, H("A")).run();

    await index(env);
    expect(await versions()).toEqual([expect.objectContaining({ path: a.path, license: "MIT", module: "Again" })]);
  });
});

describe("readManifest", () => {
  const path = parseSourcePath("github.com/acme/json-codec");

  it("reads emela, license, module and the dependencies", () => {
    const manifest = [
      "[pome]",
      'name = "github.com/acme/json-codec"',
      'emela = "0.26.1"',
      'license = "MIT OR Apache-2.0"',
      'module = "Codec"',
      "[dependencies]",
      '"github.com/emela-lang/x/sql" = "v0.3.1"',
      '"github.com/acme/http" = { version = "v1.4.0", module = "AcmeHttp" }',
    ].join("\n");
    expect(readManifest(path, manifest)).toEqual({
      emela: "0.26.1",
      license: "MIT OR Apache-2.0",
      module: "Codec",
      dependencies: [
        { path: "github.com/acme/http", requirement: "v1.4.0" },
        { path: "github.com/emela-lang/x/sql", requirement: "v0.3.1" },
      ],
    });
  });

  it("has defaults for what Pome.toml says nothing of", () => {
    expect(readManifest(path, '[pome]\nname = "github.com/acme/json-codec"\n')).toEqual({
      emela: "",
      license: undefined,
      module: "JsonCodec",
      dependencies: [],
    });
  });

  it("treats a license that is not an expression as none", () => {
    expect(readManifest(path, '[pome]\nlicense = "MIT or whatever"\n').license).toBeUndefined();
    expect(readManifest(path, "[pome]\nlicense = 1\n").license).toBeUndefined();
  });
});

describe("defaultRootName", () => {
  it("is the last segment in PascalCase, without /vN", () => {
    expect(defaultRootName(parseSourcePath("github.com/emela-lang/x/platform-cloudflare"))).toBe("PlatformCloudflare");
    expect(defaultRootName(parseSourcePath("github.com/acme/http/v2"))).toBe("Http");
    expect(defaultRootName(parseSourcePath("github.com/acme/http_2"))).toBe("Http2");
  });

  it("is empty when no type name can be made", () => {
    expect(defaultRootName(parseSourcePath("github.com/acme/Kit"))).toBe("");
    expect(defaultRootName(parseSourcePath("github.com/acme/x-y"))).toBe("");
    expect(defaultRootName(parseSourcePath("github.com/acme/a.b"))).toBe("");
  });
});

describe("isLicenseExpression", () => {
  it("takes the forms of the SPDX annex", () => {
    for (const e of [
      "MIT",
      "MIT OR Apache-2.0",
      "Apache-2.0 AND MIT",
      "Apache-2.0 WITH LLVM-exception",
      "LicenseRef-Acme-Internal",
      "GPL-2.0+",
      "(MIT OR Apache-2.0) AND BSD-3-Clause",
      "DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2",
    ]) {
      expect(isLicenseExpression(e), e).toBe(true);
    }
  });

  it("refuses the rest", () => {
    for (const e of ["", "MIT or Apache-2.0", "MIT OR", "(MIT", "MIT)", "AND", "MIT WITH", "MIT Apache-2.0", "MIT/X11"]) {
      expect(isLicenseExpression(e), e).toBe(false);
    }
  });
});
