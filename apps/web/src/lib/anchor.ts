import { hexToBytes } from "viem";
import type { Hex } from "./types";

export const ANCHOR_DOMAIN_V2 = "qorechain-multilayer-anchor-v2";
/** Height on qorechain-diana from which anchors are signed over the v2 bytes (the `rdk-integrity` upgrade). */
export const ANCHOR_V2_HEIGHT = 6_905_034n;

export interface AnchorFields {
  chainId: string;
  layerId: string;
  layerHeight: bigint;
  stateRoot: Hex;
  validatorSetHash: Hex;
  transactionCount: bigint;
  compressedStateProof?: Hex;
}

const u64 = (v: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v);
  return out;
};

/**
 * The exact bytes a rollup creator signs with ML-DSA-87 for each anchored batch (docs/SPEC.md, "Anchor bytes").
 * Every variable field is length-prefixed with a big-endian u64, so no field can bleed into the next.
 */
export function anchorSignBytesV2(a: AnchorFields): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(ANCHOR_DOMAIN_V2)];
  const withLen = (b: Uint8Array) => parts.push(u64(BigInt(b.length)), b);
  withLen(enc.encode(a.chainId));
  withLen(enc.encode(a.layerId));
  parts.push(u64(a.layerHeight));
  withLen(hexToBytes(a.stateRoot));
  withLen(hexToBytes(a.validatorSetHash));
  parts.push(u64(a.transactionCount));
  withLen(hexToBytes(a.compressedStateProof ?? "0x"));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
