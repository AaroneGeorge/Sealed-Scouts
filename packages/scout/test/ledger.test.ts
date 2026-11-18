import { describe, expect, it } from "vitest";
import { decodeQledgerTx, encodeQledgerDeposit, verifyQledgerTx } from "@qorechain/rdk";
import { decodeMsg } from "@sealed-scouts/core";
import { joinPayload, ledgerKeyOf, nextNonce, withdrawalPayload } from "../src/ledger.js";
import { CHAIN_ID, ROLLUP_ID, testScout } from "./helpers.js";

describe("scout ledger account", () => {
  const scout = testScout();
  const key = ledgerKeyOf(scout.keys.pqc.secretKey);
  const env = { chainId: CHAIN_ID, rollupId: ROLLUP_ID };

  it("is derived from the ML-DSA-87 key, the same every time", () => {
    expect(ledgerKeyOf(scout.keys.pqc.secretKey).accountId).toEqual(key.accountId);
    expect(ledgerKeyOf(testScout().keys.pqc.secretKey).accountId).not.toEqual(key.accountId);
  });

  it("JOIN carries the 32-byte account id", () => {
    expect(decodeMsg(joinPayload(key))).toEqual({ kind: "JOIN", account: key.accountId });
  });

  it("builds a valid withdrawal with the next nonce from a ledger replay", () => {
    const deposit = { height: 1, poster: "deposit:qor1x", payload: encodeQledgerDeposit(key.accountId, 5_000_000n) };
    expect(nextNonce(env, [deposit], key)).toEqual({ nonce: 0n, balance: 5_000_000n });
    const w = withdrawalPayload({ ...env, key, nonce: 0n, amount: 1_000_000n, recipient: scout.address });
    const tx = decodeQledgerTx(w)!;
    expect(verifyQledgerTx(tx, CHAIN_ID, ROLLUP_ID)).toBe(true);
    expect(tx.recipient).toBe(scout.address);
    expect(nextNonce(env, [deposit, { height: 2, poster: scout.address, payload: w }], key)).toEqual({ nonce: 1n, balance: 4_000_000n });
  });
});
