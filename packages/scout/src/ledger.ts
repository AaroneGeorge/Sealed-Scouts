// The scout's rollup ledger account (ML-DSA-44, fixed by qledger-v1): JOIN tells the operator where to pay
// rewards, and a signed withdrawal moves them back to the scout's QoreChain account.
import { createHash } from "node:crypto";
import { QledgerLedger, encodeQledgerTx, executeQledger, qledgerKeypairFromSeed, signQledgerTx, type QledgerEntry } from "@qorechain/rdk";
import { encodeMsg } from "@sealed-scouts/core";

const LEDGER_SEED_DOMAIN = "sealed-scouts/ledger-key/v1|";

export interface LedgerKey { publicKey: Uint8Array; secretKey: Uint8Array; accountId: Uint8Array }

/**
 * Derived from the scout's ML-DSA-87 secret key, not its classical key: an attacker who recovers the
 * secp256k1 key must not get the reward account too.
 */
export function ledgerKeyOf(pqSecretKey: Uint8Array): LedgerKey {
  const seed = createHash("sha256").update(LEDGER_SEED_DOMAIN).update(pqSecretKey).digest();
  return qledgerKeypairFromSeed(new Uint8Array(seed));
}

export const joinPayload = (key: LedgerKey): Uint8Array => encodeMsg({ kind: "JOIN", account: key.accountId });

/** The nonce the account's next ledger transaction needs: replay every inbox entry so far. */
export function nextNonce(env: { chainId: string; rollupId: string }, entries: QledgerEntry[], key: LedgerKey): { nonce: bigint; balance: bigint } {
  const ledger = new QledgerLedger();
  executeQledger(env, ledger, entries);
  return ledger.get(key.accountId);
}

/** A signed qledger-v1 withdrawal; post it alone (one ledger transaction per post). */
export function withdrawalPayload(input: { chainId: string; rollupId: string; key: LedgerKey; nonce: bigint; amount: bigint; recipient: string }): Uint8Array {
  const { chainId, rollupId, key, nonce, amount, recipient } = input;
  if (amount <= 0n) throw new Error("amount must be above zero");
  return encodeQledgerTx(signQledgerTx({ chainId, rollupId, secretKey: key.secretKey, publicKey: key.publicKey, nonce, amount, recipient }));
}
