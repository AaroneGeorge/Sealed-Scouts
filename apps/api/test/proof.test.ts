import { describe, expect, it } from "vitest";
import { CLAIMS, renderProof, txCell, type AttackRun } from "../scripts/proof.js";

const run = (note: string, where = "evm"): AttackRun => ({
  name: "stolen-keys", note, at: "2026-11-20T00:00:00Z",
  steps: [{ attack: "stolen-keys", step: "forged batch", verdict: "REFUSED", where, evidence: { revert: "BadAnchorSignature", txHash: `0x${"cd".repeat(32)}` } }],
});

describe("PROOF.md generator", () => {
  it("lists every claim as pending when there is no evidence", () => {
    const md = renderProof(undefined, [], "now");
    expect(md.match(/\| pending \|/g)).toHaveLength(CLAIMS.length);
    expect(md).toContain(`0 of ${CLAIMS.length} claims have evidence`);
    expect(md).toContain("No live attack runs recorded yet");
  });

  it("links native txs to the public REST endpoint and counts them", () => {
    const md = renderProof({ claims: { "rollup-created": { tx: "ab".repeat(32), note: "created at height 1" } } }, [], "now");
    expect(md).toContain(`https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${"AB".repeat(32)}`);
    expect(md).toContain("created at height 1");
    expect(md).toContain(`1 of ${CLAIMS.length} claims`);
  });

  it("marks EVM txs with the read to repeat", () => {
    expect(txCell(`0x${"12".repeat(32)}`)).toContain("eth_getTransactionReceipt");
  });

  it("lists live attack runs only, with their evidence", () => {
    expect(renderProof(undefined, [run("DRY RUN: local checks")], "now")).toContain("No live attack runs recorded yet");
    const md = renderProof(undefined, [run("Live testnet run (qorechain-diana).")], "now");
    expect(md).toContain("**REFUSED**");
    expect(md).toContain("revert `BadAnchorSignature`");
    expect(md).toContain("eth_getTransactionReceipt");
  });

  it("labels simulation steps", () => {
    expect(renderProof(undefined, [run("Live testnet run.", "simulation")], "now")).toContain("(simulation, local chain)");
  });
});
