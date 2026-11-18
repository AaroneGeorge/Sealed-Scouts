import { describe, expect, it } from "vitest";
import { checkQledgerFraud, decodeQledgerFraudProof, qledgerKeypairFromSeed } from "@qorechain/rdk";
import { LedgerReplay } from "../src/ledger.js";
import { SimRollup } from "../src/sim.js";

function world() {
  const sim = new SimRollup();
  const scout = qledgerKeypairFromSeed(new Uint8Array(32).fill(7));
  sim.deposit(sim.operatorLedger.accountId, 5_000_000n);
  sim.pay(scout.accountId, 1_000n);
  return { sim, scout };
}

describe("LedgerReplay", () => {
  it("accepts honest batches", () => {
    const { sim } = world();
    sim.submitBatch();
    sim.pay(sim.operatorLedger.accountId, 1n);
    sim.submitBatch();
    const out = new LedgerReplay(sim.env).replay(sim.batches, sim.entries);
    expect(out.map((b) => b.verdict)).toEqual(["ok", "ok"]);
  });

  it("catches a wrong state root with a fraud proof the chain's own check upholds", () => {
    const { sim, scout } = world();
    sim.submitBatch();
    sim.pay(scout.accountId, 2_000n);
    const bad = sim.submitBatch({ tamper: true });
    sim.submitBatch(); // the honest batch over the same posts
    const out = new LedgerReplay(sim.env).replay(sim.batches, sim.entries);
    expect(out.map((b) => b.verdict)).toEqual(["ok", "fraud", "ok"]);
    const proof = out[1]!.proof!;
    expect(checkQledgerFraud(sim.env, bad, proof)).toBe(true);
    expect(decodeQledgerFraudProof(proof).entries).toHaveLength(1);
    // The same proof against the honest batch over the same posts is refused (it would cost the challenger).
    expect(checkQledgerFraud(sim.env, sim.batches[2]!, proof)).toBe(false);
  });

  it("catches a wrong withdrawals root", () => {
    const { sim } = world();
    const b = sim.submitBatch();
    const forged = { ...b, withdrawalsRoot: "ab".repeat(32) };
    expect(new LedgerReplay(sim.env).replay([forged], sim.entries)[0]!.verdict).toBe("fraud");
  });

  it("waits for inbox data it has not read yet, and checks each batch once", () => {
    const { sim } = world();
    sim.submitBatch();
    const r = new LedgerReplay(sim.env);
    expect(r.replay(sim.batches, sim.entries.slice(0, 1))).toEqual([]);
    expect(r.replay(sim.batches, sim.entries)).toHaveLength(1);
    expect(r.replay(sim.batches, sim.entries)).toEqual([]);
  });

  it("skips a batch the chain already rejected", () => {
    const { sim } = world();
    const b = sim.submitBatch({ tamper: true });
    expect(new LedgerReplay(sim.env).replay([{ ...b, status: "rejected" }], sim.entries)[0]!.verdict).toBe("skipped");
  });
});
