// The creator's ML-DSA-87 anchor signature for a batch, with our round hash in the validator_set_hash slot.
// RdkTxClient signs anchors only for cosmjs signers; our eth-native operator signs the same bytes itself.
import { anchorSignBytesForBatch } from "@qorechain/rdk";
import { pqcSign } from "@qorechain/sdk";
import type { Account } from "@sealed-scouts/chain";

export interface AnchorFields {
  chainId: string;
  /** The rollup's layer id. On chain it equals the rollup id. */
  layerId: string;
  batchIndex: bigint;
  stateRoot: Uint8Array;
  txCount: bigint;
  /** 32-byte round hash. */
  validatorSetHash: Uint8Array;
}

export function anchorSignature(creator: Account, f: AnchorFields): Uint8Array {
  return pqcSign(creator.keys.pqc.secretKey, anchorSignBytesForBatch(f));
}
