import { describe, expect, it } from "vitest";
import { toEvmAddress } from "@qorechain/evm";
import { ScoutEligibility, bondEligible } from "../src/bonds.js";

const A = "qor1gydsf0760dumk23gzph45w5y8gltuch8zfn9qf";
const B = "qor1crqflnm8lwqm5arhzw3kww3kmvzz56vkgh2z0f";
const C = "qor15kzqgl4953c7fuekjwzalw3y0hy36zhc3e6ras";
const FEED = "0x00000000000000000000000000000000000000fe";

/** A fake viem client: bonds by EVM address, and a record of the block each read asked for. */
function client(bonds: Record<string, [bigint, bigint, bigint]>) {
  const blocks: bigint[] = [];
  return {
    blocks,
    readContract: async (p: { args: [string]; blockNumber: bigint }) => {
      blocks.push(p.blockNumber);
      return bonds[p.args[0].toLowerCase()] ?? [0n, 0n, 0n];
    },
  };
}

describe("scout eligibility", () => {
  it("needs a bond and no pending exit", () => {
    expect(bondEligible({ amount: 1n, exitAt: 0n, nonce: 0n })).toBe(true);
    expect(bondEligible({ amount: 1n, exitAt: 1_700_000_000n, nonce: 1n })).toBe(false);
    expect(bondEligible({ amount: 0n, exitAt: 0n, nonce: 0n })).toBe(false);
  });

  it("reads every listed scout's bond at the round's close height", async () => {
    const c = client({
      [toEvmAddress(A)]: [10n ** 18n, 0n, 0n],
      [toEvmAddress(B)]: [10n ** 18n, 1_700_000_300n, 1n], // exit pending
    });
    const e = new ScoutEligibility(c as never, [A, B, C], FEED);
    expect((await e.snapshot(7n, 12_345n)).status).toBe("ok");
    expect(c.blocks).toEqual([12_345n, 12_345n, 12_345n]);
    expect([A, B, C, "qor1unlisted"].map((s) => e.eligible(s, 7n))).toEqual([true, false, false, false]);
  });

  it("before PriceFeed exists, every listed scout is eligible", async () => {
    const e = new ScoutEligibility(client({}) as never, [A, B], undefined);
    await e.snapshot(1n, 10n);
    expect([e.eligible(A, 1n), e.eligible(C, 1n)]).toEqual([true, false]);
  });

  it("a failed historical read gives a typed unknown result and keeps no snapshot", async () => {
    const failing = { readContract: async () => { throw new Error("header not found"); } };
    const e = new ScoutEligibility(failing as never, [A], FEED);
    expect(await e.snapshot(4n, 1n)).toEqual({ status: "unknown", reason: expect.stringMatching(/header not found/) });
    expect(() => e.eligible(A, 4n)).toThrow(/no eligibility snapshot/);
  });

  it("a round without a snapshot is an error, not an empty set", async () => {
    const e = new ScoutEligibility(client({}) as never, [A], FEED);
    expect(() => e.eligible(A, 3n)).toThrow(/no eligibility snapshot for round 3/);
    await e.snapshot(3n, 10n);
    e.forget(3n);
    expect(() => e.eligible(A, 3n)).toThrow();
  });
});
