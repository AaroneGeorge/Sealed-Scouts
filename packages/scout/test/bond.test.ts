import { describe, expect, it } from "vitest";
import type { Account, Chain } from "@sealed-scouts/chain";
import { assertBonded } from "../src/live.js";

const account = { address: "qor1scout", evm: "0x00000000000000000000000000000000000000aa" } as unknown as Account;
const feed = "0x00000000000000000000000000000000000000ff" as const;
const chainWithBond = (amount: bigint, exitAt: bigint) =>
  ({ evm: { publicClient: { readContract: async () => [amount, exitAt, 0n] } } }) as unknown as Chain;

describe("assertBonded", () => {
  it("passes a listed scout with a bond and no exit", async () => {
    await expect(assertBonded(chainWithBond(1n, 0n), account, feed, ["qor1scout"])).resolves.toBeUndefined();
  });
  it("explains a missing bond or a pending exit", async () => {
    await expect(assertBonded(chainWithBond(0n, 0n), account, feed, ["qor1scout"])).rejects.toThrow(/no usable bond.*bondFor/);
    await expect(assertBonded(chainWithBond(5n, 99n), account, feed, ["qor1scout"])).rejects.toThrow(/exitAt 99/);
  });
  it("refuses an unlisted scout, and needs no bond before the feed exists", async () => {
    await expect(assertBonded(chainWithBond(1n, 0n), account, feed, [])).rejects.toThrow(/not in deployments/);
    await expect(assertBonded(chainWithBond(0n, 0n), account, undefined, ["qor1scout"])).resolves.toBeUndefined();
  });
});
