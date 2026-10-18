import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  gunzip,
  parseSourcePath,
  parseVersion,
  proxyPaths,
  readTar,
  treeHash,
} from "@pome-registry/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTags } from "../src/git.ts";
import { parseRoute } from "../src/index.ts";

const get = (path: string) => SELF.fetch(`https://pomes.example.test/${path}`);

// git の smart HTTP の ref の一覧を作る。
function advertisement(refs: string[]): Uint8Array {
  const pkt = (s: string) => `${(new TextEncoder().encode(s).length + 4).toString(16).padStart(4, "0")}${s}`;
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const lines = refs.map((r, i) => pkt(`${sha} ${r}${i === 0 ? "\0multi_ack side-band-64k" : ""}\n`));
  return new TextEncoder().encode(`${pkt("# service=git-upload-pack\n")}0000${lines.join("")}0000`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("files", () => {
  it("ingests a version, records it in the sumdb and serves it", async () => {
    const info = await get("github.com/acme/good/@v/v1.0.0.info");
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ version: "v1.0.0" });

    const toml = await get("github.com/acme/good/@v/v1.0.0.toml");
    expect(await toml.text()).toContain('name = "github.com/acme/good"');

    const archive = new Uint8Array(await (await get("github.com/acme/good/@v/v1.0.0.tar.gz")).arrayBuffer());
    const files = readTar(await gunzip(archive, 1 << 20));
    expect(files.map((f) => f.path).sort()).toEqual(["Pome.toml", "src/lib.emel"]);

    // sumdb の記録は、配ったアーカイブから計算した h1 と同じ。
    const lookup = await env.SUMDB.get("lookup/github.com/acme/good@v1.0.0");
    expect(await lookup!.text()).toContain(`github.com/acme/good v1.0.0 ${await treeHash(files)}\n`);
  });

  it("answers 410 with the reason when the ingester refuses", async () => {
    const res = await get("github.com/acme/symlink/@v/v1.0.0.tar.gz");
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("symbolic link");
  });

  it("answers 404 for a missing tag", async () => {
    expect((await get("github.com/acme/good/@v/v9.9.9.info")).status).toBe(404);
  });

  it("does not trust an ingester that lies about the tree hash", async () => {
    const res = await get("github.com/acme/liar/@v/v1.0.0.info");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("tree hash");
    expect(await env.PROXY.head(proxyPaths.info(parseSourcePath("github.com/acme/liar"), parseVersion("v1.0.0")))).toBeNull();
  });

  it("refuses a version whose content changed after it was recorded", async () => {
    expect((await get("github.com/acme/moved/@v/v1.0.0.info")).status).toBe(200);
    // R2 から消えても、sumdb の記録は残る。取り込み直すと中身が変わっている。
    const p = parseSourcePath("github.com/acme/moved");
    const v = parseVersion("v1.0.0");
    await env.PROXY.delete([proxyPaths.info(p, v), proxyPaths.manifest(p, v), proxyPaths.archive(p, v)]);
    const res = await get("github.com/acme/moved/@v/v1.0.0.info");
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("tag moved");
  });
});

describe("list and latest", () => {
  it("lists the semver tags in order and picks the latest release", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe("https://github.com/acme/good.git/info/refs?service=git-upload-pack");
      return new Response(
        advertisement([
          "HEAD",
          "refs/heads/main",
          "refs/tags/v1.0.0",
          "refs/tags/v1.0.0^{}",
          "refs/tags/v1.2.0",
          "refs/tags/v1.10.0-rc.1",
          "refs/tags/v0.9.0",
          "refs/tags/latest",
        ]) as BodyInit,
      );
    });
    expect(await (await get("github.com/acme/good/@v/list")).text()).toBe("v0.9.0\nv1.0.0\nv1.2.0\nv1.10.0-rc.1\n");
    const latest = await get("github.com/acme/good/@latest");
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ version: "v1.2.0" });
  });

  // 取り込めない版を飛ばす。tag の一覧は repo ごとに返す。
  function mockTags(tags: Record<string, string[]>) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const repo = /^https:\/\/(.+)\.git\/info\/refs/.exec(String(input))![1]!;
      return new Response(advertisement((tags[repo] ?? []).map((t) => `refs/tags/${t}`)) as BodyInit);
    });
  }

  it("skips versions that cannot be ingested", async () => {
    mockTags({ "github.com/acme/skip": ["v1.0.0", "v1.1.0", "v1.2.0", "v1.3.0-rc.1"] });
    const latest = await get("github.com/acme/skip/@latest");
    expect(latest.status).toBe(200);
    expect(await latest.json()).toMatchObject({ version: "v1.0.0" });
  });

  it("stops at a temporary failure instead of skipping it", async () => {
    mockTags({ "github.com/acme/flaky": ["v1.0.0", "v1.1.0"] });
    expect((await get("github.com/acme/flaky/@latest")).status).toBe(502);
  });

  it("gives up after five versions", async () => {
    mockTags({ "github.com/acme/symlink": ["v1.0.0", "v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0", "v1.5.0"] });
    expect((await get("github.com/acme/symlink/@latest")).status).toBe(404);
  });

  it("lists only the tags of the major that the path names", async () => {
    mockTags({ "github.com/acme/major": ["v1.0.0", "v1.1.0", "v2.0.0", "v2.1.0-rc.1", "v3.0.0"] });
    expect(await (await get("github.com/acme/major/@v/list")).text()).toBe("v1.0.0\nv1.1.0\n");
    expect(await (await get("github.com/acme/major/v2/@v/list")).text()).toBe("v2.0.0\nv2.1.0-rc.1\n");
  });

  it("lists only the tags of the directory the path names", async () => {
    mockTags({ "github.com/acme/mono": ["v1.0.0", "pkg/v0.1.0", "pkg/v0.2.0", "other/v3.0.0"] });
    expect(await (await get("github.com/acme/mono/@v/list")).text()).toBe("v1.0.0\n");
    expect(await (await get("github.com/acme/mono/pkg/@v/list")).text()).toBe("v0.1.0\nv0.2.0\n");
  });

  it("answers 404 for a version of another major", async () => {
    const res = await get("github.com/acme/good/@v/v2.0.0.info");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not a version of this Pome");
  });

  it("answers 404 for a missing repository", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect((await get("github.com/acme/nothing/@v/list")).status).toBe(404);
  });
});

describe("routing", () => {
  it("parses the proxy paths", () => {
    expect(parseRoute("github.com/!acme/x/@v/list")).toMatchObject({ kind: "list", path: "github.com/Acme/x" });
    expect(parseRoute("github.com/acme/x/@latest")).toMatchObject({ kind: "latest" });
    expect(parseRoute("github.com/acme/x/@v/v1.2.3.tar.gz")).toMatchObject({ kind: "file", file: "tar.gz" });
    for (const p of ["", "github.com/acme/x", "github.com/acme/x/@v/1.2.3.info", "github.com/Acme/x/@v/list", "github.com/acme/x/@v/v1.2.3.zip"]) {
      expect(parseRoute(p), p).toBeUndefined();
    }
  });

  it("refuses hosts it does not serve", async () => {
    expect((await get("example.com/acme/x/@v/list")).status).toBe(404);
  });

  it("parses pkt-lines by bytes", () => {
    expect(parseTags(advertisement(["refs/tags/v1.0.0", "refs/tags/日本語"]))).toEqual(["v1.0.0", "日本語"]);
  });
});
