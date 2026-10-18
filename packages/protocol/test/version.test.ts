import { describe, expect, it } from "vitest";
import { compareVersions, InvalidVersion, latestVersion, parseVersion } from "../src/index.ts";

describe("version", () => {
  it("semver の tag を読む", () => {
    expect(parseVersion("v1.2.3-rc.1")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"] });
  });

  it.each(["1.2.3", "v1.2", "v01.2.3", "v1.2.3+build", "v1.2.3-", "v1.2.3-01"])("%j を拒否する", (s) =>
    expect(() => parseVersion(s)).toThrow(InvalidVersion),
  );

  it("semver の優先順位で並べる", () => {
    const order = ["v1.0.0-alpha", "v1.0.0-alpha.1", "v1.0.0-alpha.beta", "v1.0.0-beta", "v1.0.0-beta.2", "v1.0.0-beta.11", "v1.0.0-rc.1", "v1.0.0", "v1.0.1", "v1.10.0"];
    const sorted = [...order].reverse().map(parseVersion).sort(compareVersions).map((v) => v.raw);
    expect(sorted).toEqual(order);
  });

  it("latest は prerelease でない最大を選ぶ", () => {
    expect(latestVersion(["v1.0.0", "v1.1.0-rc.1", "v0.9.0"].map(parseVersion))?.raw).toBe("v1.0.0");
    expect(latestVersion(["v1.1.0-rc.1", "v1.1.0-rc.2"].map(parseVersion))?.raw).toBe("v1.1.0-rc.2");
    expect(latestVersion([])).toBeUndefined();
  });
});
