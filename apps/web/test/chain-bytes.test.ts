import { anchorSignBytesForBatch, bech32ToHex, bytesToHex as rdkHex, decodeWireBytes, hexToBech32 } from "@qorechain/rdk";
import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";
import { anchorSignBytesV2 } from "../src/lib/anchor";
import { decodeWire, qorToHex } from "../src/lib/wire";

const fill = (n: number, b: number) => `0x${b.toString(16).padStart(2, "0").repeat(n)}` as const;

describe("anchor bytes match the RDK", () => {
  const vectors = [
    { layerId: "sealed-scouts-1", batchIndex: 7n, stateRoot: fill(32, 0x11), txCount: 4n, vsh: fill(32, 0xab) },
    { layerId: "sealed-scouts-1", batchIndex: 0n, stateRoot: fill(32, 0x00), txCount: 0n, vsh: undefined },
    { layerId: "vigil-1", batchIndex: 28n, stateRoot: fill(32, 0x69), txCount: 3n, vsh: undefined },
    { layerId: "x".repeat(40), batchIndex: 2n ** 63n, stateRoot: fill(32, 0xff), txCount: 2n ** 40n, vsh: fill(32, 0x01) },
    { layerId: "r", batchIndex: 1n, stateRoot: fill(32, 0x5a), txCount: 1n, vsh: fill(32, 0xcd) },
  ];
  for (const v of vectors) {
    it(`${v.layerId} batch ${v.batchIndex}`, () => {
      const ours = anchorSignBytesV2({
        chainId: "qorechain-diana", layerId: v.layerId, layerHeight: v.batchIndex, stateRoot: v.stateRoot,
        validatorSetHash: v.vsh ?? "0x", transactionCount: v.txCount,
      });
      const theirs = anchorSignBytesForBatch({
        chainId: "qorechain-diana", layerId: v.layerId, batchIndex: v.batchIndex, stateRoot: v.stateRoot.slice(2),
        txCount: v.txCount, ...(v.vsh ? { validatorSetHash: v.vsh.slice(2) } : {}),
      } as never);
      expect(bytesToHex(ours)).toBe(bytesToHex(theirs));
    });
  }

  it("is 180 bytes with a 32-byte round hash in the slot (docs/SPEC.md)", () => {
    const b = anchorSignBytesV2({ chainId: "qorechain-diana", layerId: "sealed-scouts-1", layerHeight: 1n, stateRoot: fill(32, 1),
      validatorSetHash: fill(32, 2), transactionCount: 1n });
    expect(b.length).toBe(180);
  });
});

describe("wire decoding matches the RDK", () => {
  const samples = ["69c68862b19c8faeecee42cd82bcbca6f884d169bc5bf6b55e5a71376615f868", "acaIYrGcj67s7kLNgry8pviE0Wm8W/a1XlpxN2YV+Gg=", "", "AAEC"];
  for (const s of samples) {
    it(JSON.stringify(s), () => expect(bytesToHex(decodeWire(s))).toBe(`0x${rdkHex(decodeWireBytes(s)).replace(/^0x/, "")}`));
  }
  it("treats null as empty", () => expect(decodeWire(null).length).toBe(0));
});

describe("qor addresses", () => {
  it("decode to the same 20 bytes as the RDK", () => {
    const addr = "qor107qxkklc0znm38tl0595asa9z73c69w85tsztr";
    expect(qorToHex(addr)).toBe(`0x${bech32ToHex(addr).replace(/^0x/, "")}`.toLowerCase());
  });
  it("round-trip through the RDK encoder", () => {
    const hex = "0x00112233445566778899aabbccddeeff00112233";
    expect(qorToHex(hexToBech32(hex, "qor"))).toBe(hex);
  });
  it("refuse another prefix", () => {
    expect(() => qorToHex(hexToBech32("0x00112233445566778899aabbccddeeff00112233", "cosmos"))).toThrow(/not a qor address/);
  });
});
