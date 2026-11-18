import { describe, expect, it } from "vitest";
import type { TowerStatus } from "../src/lib/types";
import { displayStatus, isSample, latestPrices } from "../src/lib/view";

const m = (price: string) => [{ feedId: 1, price, count: 5 }];
const status = (rounds: TowerStatus["latestRounds"], rollupId = "sealed-scouts-1") => ({ rollupId, latestRounds: rounds }) as TowerStatus;

describe("displayStatus", () => {
  it("prefers PriceFeed's status", () => expect(displayStatus("corrected", "median-wrong")).toBe("corrected"));
  it("falls back to the replay verdict", () => {
    expect(displayStatus(null, "no-quorum")).toBe("no-quorum");
    expect(displayStatus("none", "not-posted")).toBe("not-posted");
    expect(displayStatus(undefined, "not-posted", false)).toBe("sealed");
  });
});

describe("latestPrices", () => {
  it("takes the newest settled round that replay agrees with", () => {
    const s = status([
      { round: "1", verdict: "match", medians: m("100"), reports: 5, leftOut: 0, feedStatus: "final" },
      { round: "2", verdict: "median-wrong", medians: m("200"), reports: 5, leftOut: 0, feedStatus: "final" },
      { round: "3", verdict: "match", medians: m("300"), reports: 5, leftOut: 0, feedStatus: "pending" },
    ]);
    expect(latestPrices(s)).toEqual([{ feedId: 1, price: "100", count: 5, round: "1", status: "final" }]);
  });
  it("is empty with no settled round", () => expect(latestPrices(status([]))).toEqual([]));
});

describe("isSample", () => {
  it("marks the simulated history", () => {
    expect(isSample(status([], "sealed-scouts-sim"))).toBe(true);
    expect(isSample(status([]))).toBe(false);
  });
});
