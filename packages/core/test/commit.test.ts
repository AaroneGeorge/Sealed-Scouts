import { messagePqSignBytes } from "@qorechain/qoresign";
import { describe, expect, it } from "vitest";
import {
  commitSigHash, commitSignBytes, commitText, commitment, qorAddress, scoutAddress, signCommit, toHex, verifyCommit,
} from "../src/index.js";
import { testKey } from "../scripts/test-keys.js";

const k = testKey("scout1");
const other = testKey("rogue");
const salt = new Uint8Array(16).fill(5);
const p = { feedIds: [1, 2], prices: [312_000_000_000n, 9_700_000_000_000n] };
const c = commitment(42n, k.address, salt, p);
const ctx = { chainId: "qorechain-diana", rollupId: "sealed-scouts-1", round: 42n, scout: k.qor, commitment: c };

describe("commitment", () => {
  it("is SHA-256 over the spec layout", async () => {
    const { createHash } = await import("node:crypto");
    const pre = Buffer.concat([
      Buffer.from("sealed-scouts/report/v1"), Buffer.from("000000000000002a", "hex"), Buffer.from(k.address.slice(2), "hex"), salt,
      Buffer.from([2]), Buffer.from("0001" + (312_000_000_000n).toString(16).padStart(32, "0"), "hex"),
      Buffer.from("0002" + (9_700_000_000_000n).toString(16).padStart(32, "0"), "hex"),
    ]);
    expect(toHex(c)).toBe(`0x${createHash("sha256").update(pre).digest("hex")}`);
  });

  it("changes with every input", () => {
    const base = toHex(c);
    expect(toHex(commitment(43n, k.address, salt, p))).not.toBe(base);
    expect(toHex(commitment(42n, other.address, salt, p))).not.toBe(base);
    expect(toHex(commitment(42n, k.address, new Uint8Array(16).fill(6), p))).not.toBe(base);
    expect(toHex(commitment(42n, k.address, salt, { feedIds: [1, 2], prices: [312_000_000_001n, 9_700_000_000_000n] }))).not.toBe(base);
  });
});

describe("COMMIT signature", () => {
  it("text and signed bytes follow QoreSign message v1", () => {
    expect(commitText(ctx)).toBe(`sealed-scouts/commit/v1|sealed-scouts-1|42|${k.qor}|${toHex(c).slice(2)}`);
    expect(toHex(commitSignBytes(ctx))).toBe(toHex(messagePqSignBytes("qorechain-diana", commitText(ctx))));
  });

  it("verifies only for the right key, round, scout, rollup and chain", () => {
    const sig = signCommit(k.secretKey, ctx);
    expect(sig.length).toBe(4627);
    expect(verifyCommit(k.publicKey, ctx, sig)).toBe(true);
    expect(verifyCommit(other.publicKey, ctx, sig)).toBe(false);
    expect(verifyCommit(k.publicKey, { ...ctx, round: 43n }, sig)).toBe(false);
    expect(verifyCommit(k.publicKey, { ...ctx, scout: other.qor }, sig)).toBe(false);
    expect(verifyCommit(k.publicKey, { ...ctx, rollupId: "x" }, sig)).toBe(false);
    expect(verifyCommit(k.publicKey, { ...ctx, chainId: "qorechain-mainnet" }, sig)).toBe(false);
    expect(verifyCommit(k.publicKey, ctx, sig.subarray(1))).toBe(false);
    const flipped = sig.slice();
    flipped[100]! ^= 1;
    expect(verifyCommit(k.publicKey, ctx, flipped)).toBe(false);
  });

  it("commitSigHash is keccak256 of the signature", () => {
    expect(commitSigHash(new Uint8Array())).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });
});

describe("addresses", () => {
  it("round-trips qor1 and 20-byte hex, and rejects others", () => {
    expect(scoutAddress(k.qor)).toBe(k.address);
    expect(qorAddress(k.address)).toBe(k.qor);
    expect(scoutAddress("qor1notanaddress")).toBeUndefined();
    expect(scoutAddress("cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu")).toBeUndefined();
    expect(() => qorAddress("0x1234")).toThrow();
  });
});
