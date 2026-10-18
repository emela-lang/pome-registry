import { describe, expect, it } from "vitest";
import { formatRecord, InvalidRecord, parseRecord, parseSourcePath, parseVersion } from "../src/index.ts";

const tree = "h1:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=" as const;
const manifest = "h1:ypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLs=" as const;
const text =
  `github.com/emela-lang/quince v0.3.2 ${tree}\n` + `github.com/emela-lang/quince v0.3.2/Pome.toml ${manifest}\n`;

describe("sum record", () => {
  it("書いて読み戻せる", () => {
    const r = { path: parseSourcePath("github.com/emela-lang/quince"), version: parseVersion("v0.3.2"), tree, manifest };
    expect(formatRecord(r)).toBe(text);
    expect(parseRecord(text)).toMatchObject({ path: r.path, tree, manifest });
  });

  it.each([
    ["改行で終わらない", text.slice(0, -1)],
    ["2行目の version が違う", text.replace("v0.3.2/Pome.toml", "v0.3.3/Pome.toml")],
    ["空白が2つ", text.replace(" v0.3.2 ", "  v0.3.2 ")],
    ["ハッシュが短い", text.replace(tree, "h1:abc")],
  ])("%s記録を拒否する", (_, t) => expect(() => parseRecord(t)).toThrow(InvalidRecord));
});
