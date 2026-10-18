import { describe, expect, it } from "vitest";
import { parseSourcePath, parseVersion, proxyPaths, sumdbPaths, tileIndex } from "../src/index.ts";

const p = parseSourcePath("github.com/Acme/quince");
const v = parseVersion("v0.3.2");

describe("layout", () => {
  it("proxy の並び", () => {
    expect(proxyPaths.list(p)).toBe("github.com/!acme/quince/@v/list");
    expect(proxyPaths.manifest(p, v)).toBe("github.com/!acme/quince/@v/v0.3.2.toml");
    expect(proxyPaths.archive(p, v)).toBe("github.com/!acme/quince/@v/v0.3.2.tar.gz");
  });

  it("tile の番号は C2SP tlog-tiles の形", () => {
    expect(tileIndex(0)).toBe("000");
    expect(tileIndex(999)).toBe("999");
    expect(tileIndex(1000)).toBe("x001/000");
    expect(tileIndex(1234067)).toBe("x001/x234/067");
    expect(sumdbPaths.tile(0, 1234067)).toBe("tile/0/x001/x234/067");
    expect(sumdbPaths.entries(5, 17)).toBe("tile/entries/005.p/17");
    expect(sumdbPaths.lookup(p, v)).toBe("lookup/github.com/!acme/quince@v0.3.2");
  });
});
