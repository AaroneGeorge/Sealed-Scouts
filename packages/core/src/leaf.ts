// Report leaves and the reportsRoot Merkle tree. Must match the Solidity court byte for byte.
import { encodeAbiParameters, keccak256 } from "viem";
import { concatBytes, fromHex, toHex, type Hex } from "./bytes.js";

/** One counted report. `salt` is 16 bytes; feedIds ascending. */
export interface Leaf {
  round: bigint;
  scout: Hex;
  salt: Uint8Array;
  feedIds: number[];
  prices: bigint[];
  commitSigHash: Hex;
}

const LEAF_ABI = [
  { type: "uint64" }, { type: "address" }, { type: "bytes16" }, { type: "uint16[]" }, { type: "uint128[]" }, { type: "bytes32" },
] as const;

/** keccak256(abi.encode(round, scout, salt, feedIds, prices, commitSigHash)): six values, not one struct. */
export function leafHash(l: Leaf): Hex {
  return keccak256(encodeAbiParameters(LEAF_ABI, [l.round, l.scout, toHex(l.salt), l.feedIds, l.prices, l.commitSigHash]));
}

/** Leaves in tree order: ascending scout address. */
export function sortLeaves(leaves: Leaf[]): Leaf[] {
  return [...leaves].sort((a, b) => (a.scout.toLowerCase() < b.scout.toLowerCase() ? -1 : a.scout.toLowerCase() > b.scout.toLowerCase() ? 1 : 0));
}

/** Commutative pair hash (smaller first), as OpenZeppelin MerkleProof uses, so proofs need no left/right flags. */
export function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return keccak256(concatBytes(fromHex(x), fromHex(y)));
}

/** Tree layers from the leaf hashes up to the root. An odd node is carried up unchanged. */
function layers(hashes: Hex[]): Hex[][] {
  const out = [hashes];
  while (out[out.length - 1]!.length > 1) {
    const prev = out[out.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!);
    out.push(next);
  }
  return out;
}

export const ZERO_ROOT: Hex = `0x${"00".repeat(32)}`;

/** reportsRoot over leaves (sorted here by scout). Zero for no leaves; the leaf hash itself for one leaf. */
export function reportsRoot(leaves: Leaf[]): Hex {
  if (leaves.length === 0) return ZERO_ROOT;
  const l = layers(sortLeaves(leaves).map(leafHash));
  return l[l.length - 1]![0]!;
}

/** Proof for the leaf of `scout`: sibling hashes from the bottom up. Works with OpenZeppelin MerkleProof.verify. */
export function merkleProof(leaves: Leaf[], scout: Hex): Hex[] {
  const sorted = sortLeaves(leaves);
  let i = sorted.findIndex((l) => l.scout.toLowerCase() === scout.toLowerCase());
  if (i < 0) throw new Error(`no leaf for ${scout}`);
  const proof: Hex[] = [];
  for (const layer of layers(sorted.map(leafHash)).slice(0, -1)) {
    const sib = i ^ 1;
    if (sib < layer.length) proof.push(layer[sib]!);
    i >>= 1;
  }
  return proof;
}

export function verifyMerkleProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  return proof.reduce(hashPair, leaf).toLowerCase() === root.toLowerCase();
}
