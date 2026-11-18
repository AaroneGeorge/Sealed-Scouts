import { describe, expect, it } from "vitest";
import { accountFromMnemonic } from "@sealed-scouts/chain";
import type { RoundAttestation } from "@sealed-scouts/core";
import { Relayer } from "../src/relay.js";

const att: RoundAttestation = {
  round: 3n, batchIndex: 1n, inboxStart: 0n, inboxEnd: 7n, closeHeight: 100n, closeTime: 1n,
  feedIds: [1], medians: [1n], counts: [3], reportsRoot: `0x${"00".repeat(32)}`, reportCount: 3,
};

/** A stand-in chain whose EVM answers what the test sets. */
function fakeChain(o: { verify: boolean; status: "success" | "reverted" }) {
  const sent: string[] = [];
  const chain = {
    native: { resync: () => {} },
    evm: {
      publicClient: {
        readContract: async () => o.verify,
        estimateContractGas: async () => 400_000n,
        waitForTransactionReceipt: async () => ({ status: o.status, gasUsed: 390_000n }),
      },
      ensureWindow: async () => "still-open",
      wallet: () => ({ writeContract: async () => (sent.push("postRound"), "0xabc") }),
    },
  };
  return { chain: chain as never, sent };
}

describe("Relayer.postRound", () => {
  it("throws when the postRound tx reverts, so it is never logged as relayed", async () => {
    const acct = await accountFromMnemonic("CUSTOM", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const f = fakeChain({ verify: true, status: "reverted" });
    await expect(new Relayer(f.chain, acct, "0x00000000000000000000000000000000000000fe").postRound(att, "0x00", 1n, "0x00")).rejects.toThrow(/ended "reverted"/);
  });

  it("sends nothing when PriceFeed.verifyReceipt refuses the round (the gate)", async () => {
    const acct = await accountFromMnemonic("CUSTOM", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const f = fakeChain({ verify: false, status: "success" });
    await expect(new Relayer(f.chain, acct, "0x00000000000000000000000000000000000000fe").postRound(att, "0x00", 1n, "0x00")).rejects.toThrow(/verifyReceipt refused/);
    expect(f.sent).toEqual([]);
  });

  it("returns the receipt on success", async () => {
    const acct = await accountFromMnemonic("CUSTOM", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const f = fakeChain({ verify: true, status: "success" });
    expect(await new Relayer(f.chain, acct, "0x00000000000000000000000000000000000000fe").postRound(att, "0x00", 1n, "0x00")).toMatchObject({ hash: "0xabc", status: "success" });
  });
});
