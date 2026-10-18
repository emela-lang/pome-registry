import { describe, expect, it } from "vitest";
import {
  escapeSourcePath,
  InvalidSourcePath,
  directoryOf,
  isVersionOf,
  majorOf,
  parseSourcePath,
  parseVersion,
  repositoryOf,
  tagOf,
  versionOfTag,
  unescapeSourcePath,
} from "../src/index.ts";

describe("source path", () => {
  it.each(["github.com/emela-lang/stdlib", "github.com/Acme/Json-Codec", "git.example.co.jp/a/b/c"])(
    "%s を受け付ける",
    (p) => expect(parseSourcePath(p)).toBe(p),
  );

  it.each([
    "",
    "github.com",
    "GitHub.com/a/b",
    "localhost/a",
    "https://github.com/a/b",
    "github.com/a/b.git",
    "github.com/a/../b",
    "github.com/a//b",
    "github.com/.hidden/b",
    "github.com/a/b.",
    "github.com/a/v0",
    "github.com/a/b/v1",
    "github.com/a/b/v02",
    "github.com/v2",
  ])("%j を拒否する", (p) => expect(() => parseSourcePath(p)).toThrow(InvalidSourcePath));

  it("大文字を ! でエスケープし，戻せる", () => {
    const p = parseSourcePath("github.com/Acme/JSON");
    const e = escapeSourcePath(p);
    expect(e).toBe("github.com/!acme/!j!s!o!n");
    expect(unescapeSourcePath(e)).toBe(p);
  });

  it.each(["github.com/Acme/x", "github.com/!/x", "github.com/!1/x"])("エスケープとして正しくない %j を拒否する", (e) =>
    expect(() => unescapeSourcePath(e)).toThrow(InvalidSourcePath),
  );

  it("末尾の /vN を major として読み，外したものをリポジトリにする", () => {
    const v2 = parseSourcePath("github.com/acme/http/v2");
    expect(majorOf(v2)).toBe(2);
    expect(repositoryOf(v2)).toBe("github.com/acme/http");
    const v1 = parseSourcePath("github.com/acme/http");
    expect(majorOf(v1)).toBeUndefined();
    expect(repositoryOf(v1)).toBe("github.com/acme/http");
    expect(majorOf(parseSourcePath("github.com/acme/v2/x"))).toBeUndefined();
  });

  it("major と /vN が合う tag だけをその Pome の版とみなす", () => {
    const v1 = parseSourcePath("github.com/acme/http");
    const v2 = parseSourcePath("github.com/acme/http/v2");
    expect(["v0.3.0", "v1.4.0", "v2.0.0"].map((v) => isVersionOf(v1, parseVersion(v)))).toEqual([true, true, false]);
    expect(["v1.4.0", "v2.0.0", "v2.1.0-rc.1", "v3.0.0"].map((v) => isVersionOf(v2, parseVersion(v)))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("github.com ではリポジトリの中のディレクトリの Pome を読む", () => {
    const p = parseSourcePath("github.com/emela-lang/x/platform-cloudflare");
    expect([repositoryOf(p), directoryOf(p)]).toEqual(["github.com/emela-lang/x", "platform-cloudflare"]);
    expect(tagOf(p, parseVersion("v0.1.0"))).toBe("platform-cloudflare/v0.1.0");
    expect(versionOfTag(p, "platform-cloudflare/v0.1.0")?.raw).toBe("v0.1.0");
    expect(versionOfTag(p, "v0.1.0")).toBeUndefined();
    expect(versionOfTag(p, "other/v0.1.0")).toBeUndefined();

    const v2 = parseSourcePath("github.com/emela-lang/x/a/b/v2");
    expect([repositoryOf(v2), directoryOf(v2)]).toEqual(["github.com/emela-lang/x", "a/b"]);
    expect(versionOfTag(v2, "a/b/v2.1.0")?.raw).toBe("v2.1.0");
    expect(versionOfTag(v2, "a/b/v1.0.0")).toBeUndefined();

    const root = parseSourcePath("github.com/emela-lang/x");
    expect(directoryOf(root)).toBeUndefined();
    expect(versionOfTag(root, "platform-cloudflare/v0.1.0")).toBeUndefined();
    expect(repositoryOf(parseSourcePath("git.example.com/a/b/c"))).toBe("git.example.com/a/b/c");
    expect(() => parseSourcePath("github.com/acme")).toThrow(InvalidSourcePath);
    expect(() => parseSourcePath("github.com/acme/v2")).toThrow(InvalidSourcePath);
  });
});
