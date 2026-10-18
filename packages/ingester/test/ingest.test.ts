import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  gunzip,
  INGEST_PART_ARCHIVE,
  INGEST_PART_META,
  INGEST_PATH,
  type IngestMeta,
  importSigningKey,
  readTar,
  signRequest,
  treeHash,
} from "@pome-registry/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingest, type IngestOptions } from "../src/ingest.ts";
import { isPublic } from "../src/net.ts";
import { createIngester } from "../src/server.ts";

const root = mkdtempSync(join(tmpdir(), "pome-repos-"));
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd });

type Repo = { files?: Record<string, string>; tags: string[]; annotated?: boolean; setup?: (dir: string) => void };

function repo(path: string, r: Repo): void {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "--quiet", "-b", "main");
  for (const [name, text] of Object.entries(r.files ?? {})) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  sh(dir, "add", "-A");
  r.setup?.(dir);
  sh(dir, "commit", "--quiet", "-m", "c");
  for (const t of r.tags) sh(dir, "tag", ...(r.annotated ? ["-a", "-m", t] : []), t);
}

const manifest = (name: string, version: string) =>
  `[pome]\nname = "${name}"\nversion = "${version}"\nemela = "0.20.1"\n`;

const options: IngestOptions = {
  allowedHosts: ["github.com"],
  repositoryUrl: (repository) => `file://${join(root, repository)}`,
  checkHost: async () => true,
  git: { timeoutMs: 10_000, allowProtocols: ["file"] },
};

beforeAll(() => {
  repo("github.com/acme/good", {
    files: { "Pome.toml": manifest("github.com/acme/good", "1.0.0"), "src/lib.emel": "pub fn f() -> Int { 1 }\n" },
    tags: ["v1.0.0"],
    annotated: true,
  });
  repo("github.com/acme/major", {
    files: { "Pome.toml": manifest("github.com/acme/major", "1.0.0") },
    tags: ["v2.0.0"],
    setup: (dir) => {
      // 同じリポジトリの v2 は、name に /v2 を付けた別の Pome。
      sh(dir, "commit", "--quiet", "-m", "v1");
      sh(dir, "tag", "v1.0.0");
      writeFileSync(join(dir, "Pome.toml"), manifest("github.com/acme/major/v2", "2.0.0"));
      sh(dir, "add", "-A");
    },
  });
  // リポジトリの根と、ディレクトリ pkg に別の Pome がある。pkg の tag は `pkg/` を前に付ける。
  repo("github.com/acme/mono", {
    files: {
      "Pome.toml": manifest("github.com/acme/mono", "1.0.0"),
      "pkg/Pome.toml": manifest("github.com/acme/mono/pkg", "0.2.0"),
      "pkg/src/lib.emel": "pub fn g() -> Int { 2 }\n",
    },
    tags: ["v1.0.0", "pkg/v0.2.0"],
  });
  repo("github.com/acme/nomanifest", { files: { "src/lib.emel": "x\n" }, tags: ["v1.0.0"] });
  repo("github.com/acme/wrongname", { files: { "Pome.toml": manifest("github.com/acme/other", "1.0.0") }, tags: ["v1.0.0"] });
  repo("github.com/acme/wrongversion", {
    files: { "Pome.toml": manifest("github.com/acme/wrongversion", "1.0.0") },
    tags: ["v1.0.1"],
  });
  repo("github.com/acme/badtoml", { files: { "Pome.toml": "[pome\n" }, tags: ["v1.0.0"] });
  repo("github.com/acme/symlink", {
    files: { "Pome.toml": manifest("github.com/acme/symlink", "1.0.0") },
    tags: ["v1.0.0"],
    setup: (dir) => {
      symlinkSync("Pome.toml", join(dir, "link"));
      sh(dir, "add", "link");
    },
  });
  repo("github.com/acme/submodule", {
    files: { "Pome.toml": manifest("github.com/acme/submodule", "1.0.0") },
    tags: ["v1.0.0"],
    setup: (dir) => sh(dir, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor`),
  });
});

const run = (path: string, version: string) => ingest({ path, version }, options);

describe("ingest", () => {
  it("reads the tree of an annotated tag", async () => {
    const result = await run("github.com/acme/good", "v1.0.0");
    if (!result.ok) throw new Error(result.body.message);
    const files = readTar(await gunzip(result.archive, 1 << 20));
    expect(files.map((f) => f.path).sort()).toEqual(["Pome.toml", "src/lib.emel"]);
    expect(result.meta.tree).toBe(await treeHash(files));
    expect(result.meta.info.version).toBe("v1.0.0");
    expect(result.meta.info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.meta.info.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(result.meta.files).toBe(2);
  });

  it("reads v1 and v2 of one repository as two Pomes", async () => {
    const v1 = await run("github.com/acme/major", "v1.0.0");
    const v2 = await run("github.com/acme/major/v2", "v2.0.0");
    if (!v1.ok || !v2.ok) throw new Error("expected both to be ingested");
    expect(v1.meta.manifest).toContain('name = "github.com/acme/major"');
    expect(v2.meta.manifest).toContain('name = "github.com/acme/major/v2"');
  });

  it("reads a Pome in a directory of its repository", async () => {
    const result = await run("github.com/acme/mono/pkg", "v0.2.0");
    if (!result.ok) throw new Error(result.body.message);
    const files = readTar(await gunzip(result.archive, 1 << 20));
    expect(files.map((f) => f.path).sort()).toEqual(["Pome.toml", "src/lib.emel"]);
    expect(result.meta.manifest).toContain('name = "github.com/acme/mono/pkg"');
  });

  it.each([
    ["github.com/acme/mono/pkg", "v1.0.0", "tag_not_found", 404],
    ["github.com/acme/mono/none", "v1.0.0", "tag_not_found", 404],
    ["github.com/acme/major", "v2.0.0", "invalid_request", 400],
    ["github.com/acme/major/v2", "v1.0.0", "invalid_request", 400],
    ["github.com/acme/good", "v1.9.9", "tag_not_found", 404],
    ["github.com/acme/nomanifest", "v1.0.0", "manifest_missing", 422],
    ["github.com/acme/wrongname", "v1.0.0", "manifest_name_mismatch", 422],
    ["github.com/acme/wrongversion", "v1.0.1", "manifest_version_mismatch", 422],
    ["github.com/acme/badtoml", "v1.0.0", "manifest_invalid", 422],
    ["github.com/acme/symlink", "v1.0.0", "symlink", 422],
    ["github.com/acme/submodule", "v1.0.0", "submodule", 422],
    ["github.com/acme/missing", "v1.0.0", "tag_not_found", 404],
    ["gitlab.com/acme/good", "v1.0.0", "host_not_allowed", 403],
    ["github.com/acme/good", "1.0.0", "invalid_request", 400],
    ["github.com/acme/good/v1", "v1.0.0", "invalid_request", 400],
  ])("refuses %s@%s with %s", async (path, version, error, status) => {
    const result = await run(path, version);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body.error).toBe(error);
      expect(result.status).toBe(status);
    }
  });
});

describe("server", () => {
  const secret = "s".repeat(32);
  const server = createIngester({ ...options, secret, maxConcurrency: 2 });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function post(body: object, key = secret) {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const headers = await signRequest(await importSigningKey(key), "POST", INGEST_PATH, bytes);
    return fetch(`${base}${INGEST_PATH}`, { method: "POST", headers, body: bytes });
  }

  it("answers multipart with meta and archive", async () => {
    const res = await post({ path: "github.com/acme/good", version: "v1.0.0" });
    expect(res.status).toBe(200);
    const form = await res.formData();
    const meta = JSON.parse(form.get(INGEST_PART_META) as string) as IngestMeta;
    const archive = new Uint8Array(await (form.get(INGEST_PART_ARCHIVE) as Blob).arrayBuffer());
    expect(await treeHash(readTar(await gunzip(archive, 1 << 20)))).toBe(meta.tree);
  });

  it("answers the error as JSON", async () => {
    const res = await post({ path: "github.com/acme/symlink", version: "v1.0.0" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "symlink" });
  });

  it("refuses a bad signature", async () => {
    expect((await post({ path: "github.com/acme/good", version: "v1.0.0" }, "x".repeat(32))).status).toBe(401);
  });
});

describe("isPublic", () => {
  it("refuses private, loopback and link-local addresses", () => {
    for (const a of ["10.0.0.1", "127.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1"]) {
      expect(isPublic(a), a).toBe(false);
    }
    for (const a of ["140.82.112.3", "2606:4700::1111", "::ffff:140.82.112.3"]) expect(isPublic(a), a).toBe(true);
  });
});
