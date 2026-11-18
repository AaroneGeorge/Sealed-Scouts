import { anchorSignBytesForBatch, anchorSignBytesV2, bytesToHex } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import { anchorSignBytes, toHex } from "../src/index.js";
import vectors from "../../../fixtures/vectors/anchor.json";
import { mldsa87 } from "@qorechain/pqc";
import { fromHex } from "../src/index.js";

const cases = vectors.cases.map((c) => ({
  chainId: c.chainId, layerId: c.layerId, batchIndex: BigInt(c.batchIndex), stateRoot: c.stateRoot as `0x${string}`,
  validatorSetHash: c.validatorSetHash as `0x${string}`, txCount: BigInt(c.txCount),
}));

describe("anchor sign bytes v2", () => {
  it.each(cases.map((c, i) => [i, c] as const))("vector %i equals RDK anchorSignBytesForBatch and anchorSignBytesV2", (_, c) => {
    const ours = toHex(anchorSignBytes(c));
    const forBatch = anchorSignBytesForBatch({
      chainId: c.chainId, layerId: c.layerId, batchIndex: c.batchIndex, stateRoot: fromHex(c.stateRoot),
      validatorSetHash: fromHex(c.validatorSetHash), txCount: c.txCount,
    } as Parameters<typeof anchorSignBytesForBatch>[0]);
    const v2 = anchorSignBytesV2({
      chainId: c.chainId, layerId: c.layerId, layerHeight: c.batchIndex, stateRoot: c.stateRoot.slice(2),
      validatorSetHash: c.validatorSetHash.slice(2), transactionCount: c.txCount,
    } as Parameters<typeof anchorSignBytesV2>[0]);
    expect(ours).toBe(`0x${bytesToHex(forBatch).replace(/^0x/, "")}`);
    expect(ours).toBe(`0x${bytesToHex(v2).replace(/^0x/, "")}`);
  });

  it("is 180 bytes on testnet with a 32-byte round hash", () => {
    expect(anchorSignBytes(cases[0]!).length).toBe(180);
  });

  it("matches RDK without a validator set hash", () => {
    const c = { ...cases[0]!, validatorSetHash: undefined };
    const rdk = anchorSignBytesForBatch({ chainId: c.chainId, layerId: c.layerId, batchIndex: c.batchIndex, stateRoot: fromHex(c.stateRoot), txCount: c.txCount } as Parameters<typeof anchorSignBytesForBatch>[0]);
    expect(toHex(anchorSignBytes(c))).toBe(`0x${bytesToHex(rdk).replace(/^0x/, "")}`);
  });

  it("vector signatures verify, and fail on one changed bit", () => {
    const pk = fromHex(vectors.publicKey);
    for (const v of vectors.cases) {
      const msg = fromHex(v.signBytes);
      expect(mldsa87.verify(pk, msg, fromHex(v.signature))).toBe(true);
      msg[msg.length - 9]! ^= 1;
      expect(mldsa87.verify(pk, msg, fromHex(v.signature))).toBe(false);
    }
  });
});
