import { describe, expect, it } from "vitest";
import { parseDeployment, timingOf, useDemo } from "../src/deployment.js";

const base = {
  rollupId: "sealed-scouts-1", operator: "qor1op", genesisHeight: "1000", evmChainId: 9800, scouts: ["qor1a"],
  params: { roundBlocks: "300", commitBlocks: "180", openBlocks: "40", revealBlocks: "40", quorum: 3, bandBps: 200, slashBps: 1000 },
  demo: { roundBlocks: "60", commitBlocks: "30", openBlocks: "10", revealBlocks: "10" },
  contracts: { PriceFeed: "0x00000000000000000000000000000000000000ff" },
};

describe("deployment and round mode", () => {
  it("parses the launch file, demo timing included", () => {
    const d = parseDeployment(base);
    expect(d.timing.roundBlocks).toBe(300n);
    expect(timingOf(d, true).roundBlocks).toBe(60n);
    expect(d.priceFeed).toBe(base.contracts.PriceFeed);
    expect(d.roundMode).toBeUndefined();
  });

  it("follows the operator's roundMode unless a flag or SS_DEMO says otherwise", () => {
    const demo = parseDeployment({ ...base, roundMode: "demo" });
    const normal = parseDeployment({ ...base, roundMode: "normal" });
    expect(useDemo(demo, undefined, {})).toBe(true);
    expect(useDemo(normal, undefined, {})).toBe(false);
    expect(useDemo(undefined, undefined, {})).toBe(false);
    expect(useDemo(demo, undefined, { SS_DEMO: "0" })).toBe(false);
    expect(useDemo(normal, undefined, { SS_DEMO: "1" })).toBe(true);
    expect(useDemo(demo, false, { SS_DEMO: "1" })).toBe(false);
    expect(parseDeployment({ ...base, roundMode: "fast" }).roundMode).toBeUndefined();
  });
});
