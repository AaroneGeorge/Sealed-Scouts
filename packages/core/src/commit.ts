// Commitments and the scout's ML-DSA-87 signature over them (docs/SPEC.md, COMMIT).
import { mldsa87 } from "@qorechain/pqc";
import { keccak256, sha256 } from "viem";
import { COMMITMENT_DOMAIN, COMMIT_TEXT_DOMAIN, MESSAGE_PQ_DOMAIN } from "./constants.js";
import { concatBytes, fromHex, toHex, u64, utf8, type Hex } from "./bytes.js";
import { encodePriceSet, type PriceSet } from "./codec.js";

/** SHA-256("sealed-scouts/report/v1" | round u64 | scout20 | salt16 | n u8 | n x (feedId u16 | price u128)). */
export function commitment(round: bigint, scout: Hex, salt: Uint8Array, p: PriceSet): Uint8Array {
  const scoutBytes = fromHex(scout);
  if (scoutBytes.length !== 20 || salt.length !== 16) throw new RangeError("scout must be 20 bytes, salt 16");
  return fromHex(sha256(concatBytes(utf8(COMMITMENT_DOMAIN), u64(round), scoutBytes, salt, encodePriceSet(p))));
}

export interface CommitContext {
  /** Cosmos chain id, e.g. "qorechain-diana". */
  chainId: string;
  rollupId: string;
  round: bigint;
  /** The scout's qor1 account (the poster of REPORT and COMMIT). */
  scout: string;
  commitment: Uint8Array;
}

/** QoreSign message v1 text: `sealed-scouts/commit/v1|<rollupId>|<round>|<scout qor1>|<commitment hex>`, hex lowercase without 0x. */
export function commitText(c: Omit<CommitContext, "chainId">): string {
  return `${COMMIT_TEXT_DOMAIN}|${c.rollupId}|${c.round}|${c.scout}|${toHex(c.commitment).slice(2)}`;
}

/** The bytes the ML-DSA-87 key signs: `"qorechain-msg-v1|" + chainId + "|" + text` (QoreSign messagePqSignBytes). */
export function commitSignBytes(c: CommitContext): Uint8Array {
  return utf8(`${MESSAGE_PQ_DOMAIN}${c.chainId}|${commitText(c)}`);
}

/** Deterministic ML-DSA-87 signature (FIPS-204 default in @qorechain/pqc). */
export function signCommit(secretKey: Uint8Array, c: CommitContext): Uint8Array {
  return mldsa87.sign(secretKey, commitSignBytes(c));
}

/** Never throws: a malformed key or signature is just not valid. */
export function verifyCommit(publicKey: Uint8Array, c: CommitContext, signature: Uint8Array): boolean {
  return mldsa87.verify(publicKey, commitSignBytes(c), signature);
}

/** keccak256 of the raw COMMIT signature. Stored in each leaf so the EVM court can match a presented signature. */
export const commitSigHash = (signature: Uint8Array): Hex => keccak256(signature);
