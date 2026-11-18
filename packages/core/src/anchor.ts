// Settlement anchor sign bytes, v2 (RDK anchorSignBytesV2 / anchorSignBytesForBatch). The EVM rebuilds the same bytes.
import { ANCHOR_DOMAIN_V2 } from "./constants.js";
import { concatBytes, fromHex, u64, utf8, type Hex } from "./bytes.js";

export interface AnchorInput {
  /** Cosmos chain id, e.g. "qorechain-diana". */
  chainId: string;
  /** The rollup's layer id as the chain reports it. */
  layerId: string;
  batchIndex: bigint;
  stateRoot: Hex | Uint8Array;
  /** Our round hash (32 bytes) in the validator_set_hash slot; empty when absent. */
  validatorSetHash?: Hex | Uint8Array;
  txCount: bigint;
}

const bytesOf = (v: Hex | Uint8Array | undefined): Uint8Array => (v === undefined ? new Uint8Array() : typeof v === "string" ? fromHex(v) : v);
const withLength = (b: Uint8Array) => concatBytes(u64(b.length), b);

/**
 * domain | u64(len) chainId | u64(len) layerId | u64 batchIndex | u64(len) stateRoot | u64(len) vsh | u64 txCount | u64(0).
 * The trailing u64(0) is the empty compressed state proof. 180 bytes for "qorechain-diana", "sealed-scouts-1", 32-byte roots.
 */
export function anchorSignBytes(a: AnchorInput): Uint8Array {
  return concatBytes(
    utf8(ANCHOR_DOMAIN_V2),
    withLength(utf8(a.chainId)),
    withLength(utf8(a.layerId)),
    u64(a.batchIndex),
    withLength(bytesOf(a.stateRoot)),
    withLength(bytesOf(a.validatorSetHash)),
    u64(a.txCount),
    withLength(new Uint8Array()),
  );
}
