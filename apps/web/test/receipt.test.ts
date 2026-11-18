import { mldsa87 } from "@qorechain/pqc";
import { decodeFunctionData, encodeFunctionResult, hexToBytes, bytesToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { anchorSignBytesV2 } from "../src/lib/anchor";
import { PQC_KEY_STATUS, PQC_VERIFY, precompileAbi, type RpcFn } from "../src/lib/evm";
import { verifyBatch, type Check } from "../src/lib/receipt";

/**
 * A fake chain with a real ML-DSA-87 key: the REST reads are canned, and the "precompile" really verifies, so a
 * changed byte fails for the same reason it fails on QoreChain.
 */
function fakeChain(opts: { vsh?: Hex; rollupMissing?: boolean } = {}) {
  const kp = mldsa87.keygen();
  const creator = "qor107qxkklc0znm38tl0595asa9z73c69w85tsztr";
  const root = `0x${"69".repeat(32)}` as Hex;
  const vsh = opts.vsh ?? (`0x${"ab".repeat(32)}` as Hex);
  const msg = anchorSignBytesV2({ chainId: "qorechain-diana", layerId: "sealed-scouts-1", layerHeight: 5n, stateRoot: root,
    validatorSetHash: vsh, transactionCount: 2n });
  const sig = mldsa87.sign(kp.secretKey, msg);
  const b64 = (h: Hex) => btoa(String.fromCharCode(...hexToBytes(h)));
  const rest = async <T,>(path: string): Promise<T> => {
    if (path.includes("/rollup/")) {
      if (opts.rollupMissing) throw new Error("HTTP 404");
      return { rollup: { layer_id: "sealed-scouts-1", creator, status: "active" } } as T;
    }
    if (path.includes("/batch/")) return { batch: { state_root: root.slice(2), status: "pending" } } as T;
    if (path.includes("/anchors/")) return { anchors: [{ layer_id: "sealed-scouts-1", layer_height: "5", state_root: b64(root),
      validator_set_hash: b64(vsh), main_chain_height: "10400000", anchored_at: "1795000000",
      pqc_aggregate_signature: b64(bytesToHex(sig)), transaction_count: "2", compressed_state_proof: null }] } as T;
    throw new Error(`unexpected ${path}`);
  };
  const rpc: RpcFn = async (method, params) => {
    if (method === "eth_chainId") return "0x2648";
    const { to, data } = (params[0] as { to: Hex; data: Hex });
    const call = decodeFunctionData({ abi: precompileAbi, data });
    if (to === PQC_KEY_STATUS) return encodeFunctionResult({ abi: precompileAbi, functionName: "pqcKeyStatus", result: [true, 1, bytesToHex(kp.publicKey), true] });
    if (to === PQC_VERIFY) {
      const [pk, s, m] = call.args as [Hex, Hex, Hex];
      return encodeFunctionResult({ abi: precompileAbi, functionName: "pqcVerify", result: mldsa87.verify(hexToBytes(pk), hexToBytes(m), hexToBytes(s)) });
    }
    throw new Error(`unexpected call to ${to}`);
  };
  return { rest, rpc, vsh };
}

const states = (cs: Check[]) => Object.fromEntries(cs.map((c) => [c.id, c.state]));

describe("verifyBatch", () => {
  it("passes all six checks for an honest anchor", async () => {
    const { rest, rpc } = fakeChain();
    const out = await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 5n }, { rest, rpc });
    expect(out.valid).toBe(true);
    expect(out.checks).toHaveLength(6);
    expect(out.checks.every((c) => c.state === "pass")).toBe(true);
    expect(out.call?.messageBytes).toBe(180);
  });

  it("fails the signature check when one digit changes", async () => {
    const { rest, rpc } = fakeChain();
    const out = await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 5n, tamper: true }, { rest, rpc });
    expect(out.valid).toBe(false);
    expect(states(out.checks).pqcSignature).toBe("fail");
    expect(states(out.checks).anchorOnChain).toBe("pass");
  });

  it("stops at step 1 when the rollup does not exist and skips the rest", async () => {
    const { rest, rpc } = fakeChain({ rollupMissing: true });
    const out = await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 5n }, { rest, rpc });
    expect(states(out.checks)).toMatchObject({ rollupLayerBinding: "fail", batchStateRoot: "skip", pqcSignature: "skip" });
  });

  it("does not find an anchor for another batch index", async () => {
    const { rest, rpc } = fakeChain();
    const out = await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 6n }, { rest, rpc });
    expect(states(out.checks).anchorOnChain).toBe("fail");
  });

  it("binds the round: the anchor slot must hold the round hash", async () => {
    const { rest, rpc, vsh } = fakeChain();
    const good = await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 5n, round: { roundHash: vsh, priceFeed: null } }, { rest, rpc });
    expect(states(good.checks).roundBinding).toBe("pass");
    // No PriceFeed yet: the last check is skipped with a clear reason, and the receipt itself still stands.
    expect(good.checks.find((c) => c.id === "feedContract")).toMatchObject({ state: "skip", detail: expect.stringMatching(/not deployed/) });
    expect(good.valid).toBe(true);
    const bad = await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 5n, round: { roundHash: `0x${"cd".repeat(32)}`, priceFeed: null } }, { rest, rpc });
    expect(states(bad.checks)).toMatchObject({ pqcSignature: "pass", roundBinding: "fail", feedContract: "skip" });
  });

  it("skips, not fails, the round checks when the feed has no round hash yet", async () => {
    const { rest, rpc } = fakeChain();
    const out = await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 5n, round: { priceFeed: null } }, { rest, rpc });
    expect(states(out.checks)).toMatchObject({ pqcSignature: "pass", roundBinding: "skip", feedContract: "skip" });
    expect(out.valid).toBe(true);
  });

  it("reports progress as each check runs", async () => {
    const { rest, rpc } = fakeChain();
    const seen: string[] = [];
    await verifyBatch({ rollupId: "sealed-scouts-1", batchIndex: 5n }, { rest, rpc }, (cs) => seen.push(cs.map((c) => c.state[0]).join("")));
    expect(seen[0]).toBe("rwwwww");
    expect(seen.at(-1)).toBe("pppppp");
  });
});
