// Writes test vectors for the Solidity contracts to repo/fixtures/vectors/*.json.
// Run: npm run vectors -w @sealed-scouts/core. Output is deterministic; the vitest suite checks it is up to date.
import { mldsa87 } from "@qorechain/pqc";
import { keccak256 } from "viem";
import {
  anchorSignBytes, commitSigHash, commitSignBytes, commitText, commitment, concatBytes, encodePriceSet, encodeRoundHashInput,
  isInBand, isOutlier, leafHash, median, merkleProof, reportsRoot, roundHash, signCommit, sortLeaves, toHex, u64, utf8,
  COMMITMENT_DOMAIN, fromHex, type Leaf, type RoundAttestation, type RoundDomain,
} from "../src/index.js";
import { testBytes, testKey } from "./test-keys.js";
import { writeJson } from "./write-json.js";

const TESTNET: RoundDomain = { chainId: 9800n, rollupId: "sealed-scouts-1" };
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const NOTE = "TEST-ONLY vectors from packages/core/scripts/gen-vectors.ts. Keys come from public seeds; never use them on chain.";

export function attestationCases(): { name: string; domain: RoundDomain; att: RoundAttestation }[] {
  const root = (s: string) => keccak256(utf8(s));
  const base: RoundAttestation = {
    round: 42n, batchIndex: 7n, inboxStart: 100n, inboxEnd: 131n, closeHeight: 1_234_680n, closeTime: 1_764_000_000n,
    feedIds: [1, 2, 3], medians: [312_345_000_000n, 9_712_300_000_000n, 99_990_000n], counts: [3, 3, 3],
    reportsRoot: root("three scouts"), reportCount: 3,
  };
  return [
    { name: "three-feeds", domain: TESTNET, att: base },
    { name: "no-quorum-empty", domain: TESTNET, att: { ...base, round: 43n, batchIndex: 8n, feedIds: [], medians: [], counts: [], reportsRoot: `0x${"00".repeat(32)}`, reportCount: 0 } },
    { name: "one-feed-five-scouts", domain: TESTNET, att: { ...base, round: 44n, feedIds: [1], medians: [300_000_000_000n], counts: [5], reportsRoot: root("five"), reportCount: 5 } },
    {
      name: "max-values", domain: TESTNET,
      att: { round: U64_MAX, batchIndex: U64_MAX, inboxStart: U64_MAX, inboxEnd: U64_MAX, closeHeight: U64_MAX, closeTime: U64_MAX,
        feedIds: [1, 2, 3, 4, 65535], medians: [1n, 2n, 3n, 4n, U128_MAX], counts: [3, 4, 5, 6, 255], reportsRoot: `0x${"ff".repeat(32)}`, reportCount: 65535 },
    },
    { name: "other-domain", domain: { chainId: 31337n, rollupId: "sealed-scouts-demo" }, att: base },
  ];
}

function roundHashVectors() {
  return {
    note: NOTE,
    formula: 'keccak256(abi.encode("sealed-scouts/round/v1", uint256 chainId, string rollupId, RoundAttestation att))',
    cases: attestationCases().map(({ name, domain, att }) => ({
      name, chainId: domain.chainId, rollupId: domain.rollupId, att,
      encoded: encodeRoundHashInput(att, domain), roundHash: roundHash(att, domain),
    })),
  };
}

export function sampleLeaves(n: number, tag: string): Leaf[] {
  return Array.from({ length: n }, (_, i) => {
    const k = testKey(`scout${i + 1}`);
    return {
      round: 42n, scout: k.address, salt: testBytes(`${tag}/salt/${i}`, 16), feedIds: [1, 2, 3],
      prices: [312_000_000_000n + BigInt(i) * 1_000_000_000n, 9_700_000_000_000n + BigInt(i) * 5_000_000_000n, 99_990_000n + BigInt(i)],
      commitSigHash: keccak256(testBytes(`${tag}/sig/${i}`, 32)),
    };
  });
}

function merkleVectors() {
  return {
    note: NOTE,
    leafFormula: "keccak256(abi.encode(uint64 round, address scout, bytes16 salt, uint16[] feedIds, uint128[] prices, bytes32 commitSigHash))",
    treeRule: "Leaves sorted by scout address ascending. Parent = keccak256(min(a,b) || max(a,b)). An odd last node moves up unchanged. One leaf: root = leaf hash. Proofs verify with OpenZeppelin MerkleProof.verify.",
    trees: [1, 2, 3, 5].map((n) => {
      const leaves = sortLeaves(sampleLeaves(n, `tree${n}`));
      return {
        size: n, root: reportsRoot(leaves),
        leaves: leaves.map((l) => ({ ...l, leafHash: leafHash(l), proof: merkleProof(leaves, l.scout) })),
      };
    }),
  };
}

function medianVectors() {
  const lists: bigint[][] = [[5n], [7n, 3n], [3n, 1n, 2n], [10n, 40n, 20n, 30n], [9n, 1n, 8n, 2n, 7n], [4n, 4n, 4n, 1n, 9n, 9n], [U128_MAX, 0n, 1n]];
  const m = 300_000_000_000n;
  const prices = [m, m + m / 50n, m + m / 50n + 1n, m - m / 50n, m - m / 50n - 1n, m + m / 10n, m + m / 10n + 1n, m - m / 10n, m - m / 10n - 1n];
  return {
    note: NOTE,
    medianRule: "element floor((n-1)/2) of the ascending list",
    medians: lists.map((values) => ({ values, index: Math.floor((values.length - 1) / 2), median: median(values) })),
    bandRule: "inBand: |p-m|*10000 <= bandBps*m. outlier: |p-m|*10000 > slashBps*m.",
    bands: prices.map((price) => ({ price, median: m, bandBps: 200, slashBps: 1000, inBand: isInBand(price, m, 200), outlier: isOutlier(price, m, 1000) })),
  };
}

function anchorVectors() {
  const op = testKey("operator");
  const hashes = roundHashVectors().cases;
  const inputs = [
    { chainId: "qorechain-diana", layerId: "sealed-scouts-1", batchIndex: 7n, stateRoot: keccak256(utf8("state-a")), txCount: 4n, vshFrom: 0 },
    { chainId: "qorechain-diana", layerId: "sealed-scouts-1", batchIndex: 8n, stateRoot: keccak256(utf8("state-b")), txCount: 0n, vshFrom: 1 },
    { chainId: "qorechain-diana", layerId: "sealed-scouts-1", batchIndex: 0n, stateRoot: keccak256(utf8("state-c")), txCount: 1n, vshFrom: 2 },
    { chainId: "qorechain-diana", layerId: "sealed-scouts-1", batchIndex: U64_MAX, stateRoot: `0x${"ff".repeat(32)}` as const, txCount: U64_MAX, vshFrom: 3 },
    { chainId: "qorechain-local", layerId: "sealed-scouts-demo", batchIndex: 1n, stateRoot: keccak256(utf8("state-e")), txCount: 2n, vshFrom: 4 },
  ];
  return {
    note: NOTE,
    layout: '"qorechain-multilayer-anchor-v2" | u64(len) chainId | u64(len) layerId | u64 batchIndex | u64(32) stateRoot | u64(32) vsh | u64 txCount | u64(0), big-endian',
    publicKey: op.publicKey,
    cases: inputs.map(({ vshFrom, ...a }) => {
      const validatorSetHash = hashes[vshFrom]!.roundHash;
      const bytes = anchorSignBytes({ ...a, validatorSetHash });
      return { ...a, validatorSetHash, roundHashCase: hashes[vshFrom]!.name, signBytes: bytes, length: bytes.length, signature: mldsa87.sign(op.secretKey, bytes) };
    }),
  };
}

function commitVectors() {
  return {
    note: NOTE,
    commitmentFormula: 'sha256("sealed-scouts/report/v1" | u64 round | scout20 | salt16 | u8 n | n x (u16 feedId | u128 price))',
    signBytesFormula: '"qorechain-msg-v1|" + chainId + "|" + "sealed-scouts/commit/v1|<rollupId>|<round>|<scout qor1>|<commitment hex, lowercase, no 0x>"',
    cases: [1, 2, 3].map((i) => {
      const k = testKey(`scout${i}`);
      const round = 42n + BigInt(i);
      const salt = testBytes(`commit/salt/${i}`, 16);
      const p = { feedIds: [1, 2, 3].slice(0, i), prices: [312_000_000_000n, 9_700_000_000_000n, 99_990_000n].slice(0, i) };
      const c = commitment(round, k.address, salt, p);
      const ctx = { chainId: "qorechain-diana", rollupId: "sealed-scouts-1", round, scout: k.qor, commitment: c };
      const signature = signCommit(k.secretKey, ctx);
      return {
        round, scout: k.address, scoutQor: k.qor, salt, ...p,
        preimage: concatBytes(utf8(COMMITMENT_DOMAIN), u64(round), fromHex(k.address), salt, encodePriceSet(p)),
        commitment: c, text: commitText(ctx), signBytes: commitSignBytes(ctx), publicKey: k.publicKey, signature, commitSigHash: commitSigHash(signature),
      };
    }),
  };
}

export function buildVectors(): Record<string, unknown> {
  return {
    "vectors/round-hash.json": roundHashVectors(),
    "vectors/merkle.json": merkleVectors(),
    "vectors/median.json": medianVectors(),
    "vectors/anchor.json": anchorVectors(),
    "vectors/commit.json": commitVectors(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, v] of Object.entries(buildVectors())) console.log("wrote", writeJson(rel, v));
}
