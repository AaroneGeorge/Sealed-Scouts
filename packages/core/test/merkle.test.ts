import { describe, expect, it } from "vitest";
import { ZERO_ROOT, hashPair, leafFromJson, leafHash, merkleProof, reportsRoot, verifyMerkleProof } from "../src/index.js";
import vectors from "../../../fixtures/vectors/merkle.json";
import { sampleLeaves } from "../scripts/gen-vectors.js";

describe("reportsRoot and proofs", () => {
  it.each(vectors.trees.map((t) => [t.size, t] as const))("tree of %i leaves matches the vector", (_, t) => {
    const leaves = t.leaves.map(leafFromJson);
    expect(reportsRoot(leaves)).toBe(t.root);
    for (const [i, l] of leaves.entries()) {
      expect(leafHash(l)).toBe(t.leaves[i]!.leafHash);
      expect(merkleProof(leaves, l.scout)).toEqual(t.leaves[i]!.proof);
      expect(verifyMerkleProof(t.root as `0x${string}`, leafHash(l), t.leaves[i]!.proof as `0x${string}`[])).toBe(true);
    }
  });

  it("does not depend on input order", () => {
    const leaves = sampleLeaves(7, "order");
    expect(reportsRoot([...leaves].reverse())).toBe(reportsRoot(leaves));
  });

  it("proves every leaf for sizes 1 to 9 and refuses a changed leaf", () => {
    for (let n = 1; n <= 9; n++) {
      const leaves = sampleLeaves(n, `size${n}`);
      const root = reportsRoot(leaves);
      for (const l of leaves) {
        const proof = merkleProof(leaves, l.scout);
        expect(verifyMerkleProof(root, leafHash(l), proof)).toBe(true);
        expect(verifyMerkleProof(root, leafHash({ ...l, prices: [l.prices[0]! + 1n, ...l.prices.slice(1)] }), proof)).toBe(false);
      }
    }
  });

  it("has a zero root for no leaves and the leaf hash for one", () => {
    expect(reportsRoot([])).toBe(ZERO_ROOT);
    const [l] = sampleLeaves(1, "one");
    expect(reportsRoot([l!])).toBe(leafHash(l!));
    expect(merkleProof([l!], l!.scout)).toEqual([]);
  });

  it("hashes pairs commutatively", () => {
    const a = `0x${"01".repeat(32)}` as const, b = `0x${"02".repeat(32)}` as const;
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });

  it("throws for a scout with no leaf", () => {
    expect(() => merkleProof(sampleLeaves(2, "x"), "0x0000000000000000000000000000000000000000")).toThrow();
  });
});
