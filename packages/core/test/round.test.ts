import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING, checkTiming, phaseOf, roundOf, roundWindows } from "../src/index.js";

const t = { genesisHeight: 1000n, ...DEFAULT_TIMING };

describe("round timing", () => {
  it("counts rounds from genesis in roundBlocks", () => {
    expect(roundOf(1000n, t)).toBe(0n);
    expect(roundOf(1299n, t)).toBe(0n);
    expect(roundOf(1300n, t)).toBe(1n);
    expect(() => roundOf(999n, t)).toThrow();
  });

  it("places commit 180, open 40, reveal 40 inside a 300-block round", () => {
    expect(roundWindows(5n, t)).toEqual({ start: 2500n, commitEnd: 2680n, openEnd: 2720n, revealEnd: 2760n, end: 2800n });
  });

  it("reports the phase at every boundary", () => {
    const at = (h: bigint) => phaseOf(h, t);
    expect(at(2500n)).toEqual({ round: 5n, phase: "commit" });
    expect(at(2679n).phase).toBe("commit");
    expect(at(2680n).phase).toBe("open");
    expect(at(2720n).phase).toBe("reveal");
    expect(at(2760n).phase).toBe("idle");
    expect(at(2800n)).toEqual({ round: 6n, phase: "commit" });
  });

  it("accepts shorter demo timing and refuses windows that do not fit", () => {
    const demo = { genesisHeight: 0n, roundBlocks: 60n, commitBlocks: 30n, openBlocks: 10n, revealBlocks: 10n };
    expect(roundWindows(2n, demo)).toEqual({ start: 120n, commitEnd: 150n, openEnd: 160n, revealEnd: 170n, end: 180n });
    expect(() => checkTiming({ ...demo, revealBlocks: 21n })).toThrow();
    expect(() => checkTiming({ ...demo, openBlocks: 0n })).toThrow();
    expect(() => roundWindows(-1n, demo)).toThrow();
  });
});
