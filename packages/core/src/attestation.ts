// The round attestation relayed to PriceFeed.sol and its hash, which rides in the anchor's validator_set_hash slot.
import { encodeAbiParameters, keccak256 } from "viem";
import { ROUND_HASH_DOMAIN } from "./constants.js";
import type { Hex } from "./bytes.js";
import type { RoundResult } from "./derive.js";

/** Mirrors the Solidity struct field for field. */
export interface RoundAttestation {
  round: bigint;
  batchIndex: bigint;
  inboxStart: bigint;
  inboxEnd: bigint;
  closeHeight: bigint;
  closeTime: bigint;
  feedIds: number[];
  medians: bigint[];
  counts: number[];
  reportsRoot: Hex;
  reportCount: number;
}

/** Where the attestation is valid: the EVM chain id (9800 on testnet) and the rollup id. */
export interface RoundDomain { chainId: bigint; rollupId: string }

export const ROUND_ATTESTATION_ABI = {
  type: "tuple",
  components: [
    { name: "round", type: "uint64" }, { name: "batchIndex", type: "uint64" }, { name: "inboxStart", type: "uint64" },
    { name: "inboxEnd", type: "uint64" }, { name: "closeHeight", type: "uint64" }, { name: "closeTime", type: "uint64" },
    { name: "feedIds", type: "uint16[]" }, { name: "medians", type: "uint128[]" }, { name: "counts", type: "uint8[]" },
    { name: "reportsRoot", type: "bytes32" }, { name: "reportCount", type: "uint16" },
  ],
} as const;

export function toAttestation(
  r: RoundResult,
  batch: { index: bigint; inboxStart: bigint; inboxEnd: bigint; closeTime: bigint },
): RoundAttestation {
  return {
    round: r.round,
    batchIndex: batch.index,
    inboxStart: batch.inboxStart,
    inboxEnd: batch.inboxEnd,
    closeHeight: r.closeHeight,
    closeTime: batch.closeTime,
    feedIds: r.medians.map((m) => m.feedId),
    medians: r.medians.map((m) => m.price),
    counts: r.medians.map((m) => m.count),
    reportsRoot: r.reportsRoot,
    reportCount: r.leaves.length,
  };
}

/** abi.encode("sealed-scouts/round/v1", uint256 chainId, string rollupId, att). */
export function encodeRoundHashInput(att: RoundAttestation, d: RoundDomain): Hex {
  return encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "string" }, ROUND_ATTESTATION_ABI],
    [ROUND_HASH_DOMAIN, d.chainId, d.rollupId, att],
  );
}

/** keccak256(abi.encode("sealed-scouts/round/v1", chainId, rollupId, att)). */
export function roundHash(att: RoundAttestation, d: RoundDomain): Hex {
  return keccak256(encodeRoundHashInput(att, d));
}
