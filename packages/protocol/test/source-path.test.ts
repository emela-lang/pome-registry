import { describe, expect, it } from "vitest";
import { escapeSourcePath, InvalidSourcePath, parseSourcePath, unescapeSourcePath } from "../src/index.ts";

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
});
