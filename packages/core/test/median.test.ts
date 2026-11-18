import { describe, expect, it } from "vitest";
import { isInBand, isOutlier, median } from "../src/index.js";
import vectors from "../../../fixtures/vectors/median.json";

describe("median", () => {
  it.each(vectors.medians.map((c) => [c.values.join(","), c] as const))("lower median of [%s]", (_, c) => {
    expect(median(c.values.map(BigInt))).toBe(BigInt(c.median));
  });
  it("takes element floor((n-1)/2) of the sorted list", () => {
    expect(median([4n, 1n, 3n, 2n])).toBe(2n);
    expect(median([1n, 2n])).toBe(1n);
    expect(median([1n, 2n, 3n])).toBe(2n);
  });
  it("throws on an empty list", () => expect(() => median([])).toThrow());
});

describe("bands", () => {
  it.each(vectors.bands.map((c) => [c.price, c] as const))("price %s", (_, c) => {
    expect(isInBand(BigInt(c.price), BigInt(c.median), c.bandBps)).toBe(c.inBand);
    expect(isOutlier(BigInt(c.price), BigInt(c.median), c.slashBps)).toBe(c.outlier);
  });
  it("is inclusive at exactly BAND_BPS and exclusive at exactly SLASH_BPS", () => {
    expect(isInBand(102n, 100n, 200)).toBe(true);
    expect(isInBand(103n, 100n, 200)).toBe(false);
    expect(isOutlier(110n, 100n, 1000)).toBe(false);
    expect(isOutlier(111n, 100n, 1000)).toBe(true);
    expect(isOutlier(89n, 100n, 1000)).toBe(true);
  });
});
