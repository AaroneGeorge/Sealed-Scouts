import { bytesToHex } from "viem";
import { ANCHOR_V2_HEIGHT, anchorSignBytesV2 } from "./anchor";
import { EVM_CHAIN_ID, ML_DSA_87, PQC_KEY_STATUS, PQC_VERIFY, precompileAbi, priceFeedAbi, readContract, type RpcFn } from "./evm";
import type { AttestationJson, Hex } from "./types";
import { qorToHex, wireHex } from "./wire";

export const CHAIN_ID = "qorechain-diana";

export type CheckId =
  | "rollupLayerBinding" | "batchStateRoot" | "anchorOnChain" | "creatorAuthority" | "chainBinding" | "pqcSignature"
  | "roundBinding" | "feedContract";

export type CheckState = "wait" | "run" | "pass" | "fail" | "skip";

export interface Check { id: CheckId; title: string; meaning: string; state: CheckState; detail?: string }

/** The six settlement-receipt checks (same names as the RDK's verifier), then two that bind our price round. */
const CHECKS: Omit<Check, "state">[] = [
  { id: "rollupLayerBinding", title: "Rollup is bound to its layer", meaning: "The chain's rollup record names the layer the anchors live on." },
  { id: "batchStateRoot", title: "Batch state root on chain", meaning: "The chain stores this batch with a non-empty state root." },
  { id: "anchorOnChain", title: "Anchor commits that root", meaning: "A main-chain anchor for this layer carries the same height and root." },
  { id: "creatorAuthority", title: "Creator holds an ML-DSA-87 key", meaning: "pqcKeyStatus on the EVM returns the creator's registered post-quantum key." },
  { id: "chainBinding", title: "Bound to this chain", meaning: "The EVM answers as chain 9800, and the anchor is signed over v2 bytes that name qorechain-diana." },
  { id: "pqcSignature", title: "ML-DSA-87 signature verifies", meaning: "pqcVerify, called on chain, accepts the anchor signature over the rebuilt bytes." },
  { id: "roundBinding", title: "Creator signed the price round", meaning: "The anchor's validator_set_hash slot holds this round's hash or, in two-signature mode, the creator's separate ML-DSA-87 round signature verifies through pqcVerify." },
  { id: "feedContract", title: "PriceFeed accepts the receipt", meaning: "PriceFeed.verifyReceipt rebuilds the bytes and the round hash itself and checks the signature." },
];

export interface VerifyInput {
  rollupId: string;
  batchIndex: bigint;
  /** Round binding: given for our own rounds, absent when checking any rollup's batch. */
  round?: {
    round: bigint;
    roundHash?: Hex;
    attestation?: AttestationJson;
    priceFeed: Hex | null;
    /** Two-signature mode (docs/SPEC.md, Changes 14). Unknown: read PriceFeed.twoSigMode(). */
    twoSig?: boolean;
    /** The anchorSig argument as posted to PriceFeed: anchorSig, or anchorSig ‖ roundSig in two-signature mode. */
    anchorSig?: Hex;
  };
  /** Change one digit in what we rebuild, to show that the same signature then fails. */
  tamper?: boolean;
}

export interface VerifyIo { rest: <T>(path: string) => Promise<T>; rpc: RpcFn }

export interface VerifyOutcome {
  valid: boolean;
  checks: Check[];
  /** What a reader needs to repeat the pqcVerify call by hand. */
  call?: { to: Hex; data: Hex; messageBytes: number; signatureBytes: number; pubkeyBytes: number };
}

interface RollupRes { rollup: { layer_id?: string; creator: string; status?: string } }
interface BatchRes { batch: { state_root?: string; status?: string; tx_count?: string } }
interface AnchorRaw {
  layer_id: string; layer_height: string; state_root: string | null; validator_set_hash: string | null;
  main_chain_height: string; anchored_at: string; pqc_aggregate_signature: string | null;
  transaction_count: string; compressed_state_proof: string | null;
}

class CheckFailed extends Error {}

const SIG_HEX = 2 * 4627;

/**
 * The anchor for one batch. The chain lists a layer's anchors in one response today; follow `next_key` in case it
 * pages, then fall back to the newest anchor (the batch a reader usually checks).
 */
async function findAnchor(rest: VerifyIo["rest"], layerId: string, batchIndex: bigint, root: Hex): Promise<AnchorRaw | undefined> {
  const hit = (x: AnchorRaw | undefined) => !!x && BigInt(x.layer_height) === batchIndex && wireHex(x.state_root) === root;
  const base = `/qorechain/multilayer/v1/anchors/${encodeURIComponent(layerId)}`;
  let key: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await rest<{ anchors?: AnchorRaw[]; pagination?: { next_key?: string | null } }>(key ? `${base}?pagination.key=${encodeURIComponent(key)}` : base);
    const found = (r.anchors ?? []).find(hit);
    if (found) return found;
    key = r.pagination?.next_key ?? undefined;
    if (!key) break;
  }
  const latest = await rest<{ anchor?: AnchorRaw }>(`/qorechain/multilayer/v1/anchor/${encodeURIComponent(layerId)}`).catch(() => undefined);
  return hit(latest?.anchor) ? latest!.anchor : undefined;
}

/** QoreSign bytes of the round signature in two-signature mode (docs/SPEC.md, Changes 14). */
export function roundSigBytes(rollupId: string, round: bigint, roundHash: Hex): Uint8Array {
  return new TextEncoder().encode(`qorechain-msg-v1|${CHAIN_ID}|sealed-scouts/round/v1|${rollupId}|${round}|${roundHash.slice(2).toLowerCase()}`);
}
/** A check that cannot run yet (for example, a contract not deployed) is skipped, not failed. */
class NotYet extends Error {}

export async function verifyBatch(input: VerifyInput, io: VerifyIo, onUpdate: (c: Check[]) => void = () => {}): Promise<VerifyOutcome> {
  const ids = CHECKS.filter((c) => input.round || (c.id !== "roundBinding" && c.id !== "feedContract"));
  const checks: Check[] = ids.map((c) => ({ ...c, state: "wait" }));
  const out: VerifyOutcome = { valid: false, checks };
  const emit = () => onUpdate(checks.map((c) => ({ ...c })));

  const step = async (id: CheckId, fn: () => Promise<string>) => {
    const c = checks.find((x) => x.id === id);
    if (!c) return;
    c.state = "run";
    emit();
    try {
      c.detail = await fn();
      c.state = "pass";
    } catch (e) {
      c.detail = (e as Error).message;
      if (e instanceof NotYet) {
        c.state = "skip";
        emit();
        return;
      }
      c.state = "fail";
      emit();
      throw new CheckFailed();
    }
    emit();
  };
  const must = (ok: unknown, why: string) => {
    if (!ok) throw new Error(why);
  };

  const { rollupId, batchIndex } = input;
  let layerId = "", creator = "", root: Hex = "0x", anchor: AnchorRaw | undefined, pubkey: Hex = "0x";
  try {
    await step("rollupLayerBinding", async () => {
      const r = await io.rest<RollupRes>(`/qorechain/rdk/v1/rollup/${encodeURIComponent(rollupId)}`).catch((e) => {
        throw new Error(`rollup "${rollupId}" was not found on chain (${(e as Error).message})`);
      });
      layerId = r.rollup.layer_id ?? "";
      creator = r.rollup.creator;
      must(layerId, `rollup "${rollupId}" has no layer, so nothing anchors it`);
      return `Rollup ${rollupId} (${r.rollup.status ?? "unknown status"}) is anchored on layer ${layerId}.`;
    });
    await step("batchStateRoot", async () => {
      const b = await io.rest<BatchRes>(`/qorechain/rdk/v1/batch/${encodeURIComponent(rollupId)}/${batchIndex}`).catch((e) => {
        throw new Error(`batch ${batchIndex} was not found on chain (${(e as Error).message})`);
      });
      root = wireHex(b.batch.state_root);
      must(root !== "0x", `batch ${batchIndex} has no state root`);
      return `Batch ${batchIndex} is ${b.batch.status ?? "stored"} with root ${root}.`;
    });
    await step("anchorOnChain", async () => {
      anchor = await findAnchor(io.rest, layerId, batchIndex, root);
      must(anchor, `no anchor on layer ${layerId} commits batch ${batchIndex} with that root`);
      return `Anchored at main-chain height ${anchor!.main_chain_height}, ${anchor!.transaction_count} transactions.`;
    });
    await step("creatorAuthority", async () => {
      const { result } = await readContract(io.rpc, PQC_KEY_STATUS, precompileAbi, "pqcKeyStatus", [qorToHex(creator)]);
      const [registered, alg, key, proven] = result as [boolean, number, Hex, boolean];
      must(registered && key !== "0x", `creator ${creator} has no registered post-quantum key`);
      must(alg === ML_DSA_87, `creator key uses algorithm ${alg}, not ML-DSA-87`);
      pubkey = key;
      return `${creator}: ML-DSA-87 key, ${(key.length - 2) / 2} bytes, possession ${proven ? "proven" : "not proven"}.`;
    });
    await step("chainBinding", async () => {
      const id = Number(BigInt((await io.rpc("eth_chainId", [])) as Hex));
      must(id === EVM_CHAIN_ID, `EVM endpoint is chain ${id}, expected ${EVM_CHAIN_ID}`);
      must(BigInt(anchor!.main_chain_height) >= ANCHOR_V2_HEIGHT, "anchor predates v2 signing bytes, which bind the chain id");
      return `EVM chain ${id}. Signed bytes name ${CHAIN_ID}.`;
    });
    await step("pqcSignature", async () => {
      const a = anchor!;
      const message = anchorSignBytesV2({
        chainId: CHAIN_ID,
        layerId: a.layer_id,
        layerHeight: BigInt(a.layer_height),
        stateRoot: wireHex(a.state_root),
        validatorSetHash: wireHex(a.validator_set_hash),
        transactionCount: BigInt(a.transaction_count) + (input.tamper ? 1n : 0n),
        compressedStateProof: wireHex(a.compressed_state_proof),
      });
      const sig = wireHex(a.pqc_aggregate_signature);
      const { data, result } = await readContract(io.rpc, PQC_VERIFY, precompileAbi, "pqcVerify", [pubkey, sig, bytesToHex(message)]);
      out.call = { to: PQC_VERIFY, data, messageBytes: message.length, signatureBytes: (sig.length - 2) / 2, pubkeyBytes: (pubkey.length - 2) / 2 };
      must(result === true, input.tamper
        ? "pqcVerify returned false: one digit changed (the transaction count), so the signature no longer matches."
        : "pqcVerify returned false for the anchor as stored on chain.");
      return `pqcVerify returned true for ${message.length} message bytes and a ${(sig.length - 2) / 2}-byte signature.`;
    });
    if (input.round) {
      const { round, roundHash, attestation, priceFeed, anchorSig } = input.round;
      const vsh = wireHex(anchor!.validator_set_hash);
      const anchorSigOnChain = wireHex(anchor!.pqc_aggregate_signature);
      let twoSig = input.round.twoSig;
      if (twoSig === undefined && priceFeed) {
        twoSig = (await readContract(io.rpc, priceFeed, priceFeedAbi, "twoSigMode", [])).result as boolean;
      }
      await step("roundBinding", async () => {
        if (!roundHash) throw new NotYet("The feed does not carry this round's hash yet.");
        if (!twoSig) {
          must(vsh.toLowerCase() === roundHash.toLowerCase(), `anchor slot holds ${vsh === "0x" ? "nothing" : vsh}, round hash is ${roundHash}`);
          return `validator_set_hash = ${roundHash}.`;
        }
        // Two-signature mode: the slot is empty by design, and the round is signed separately.
        must(vsh === "0x", `two-signature mode expects an empty anchor slot, found ${vsh}`);
        if (!anchorSig) throw new NotYet("The feed does not carry the posted signatures yet.");
        must(anchorSig.length === 2 + 2 * SIG_HEX, `expected anchorSig ‖ roundSig (2 × 4,627 bytes), got ${(anchorSig.length - 2) / 2} bytes`);
        must(`0x${anchorSig.slice(2, 2 + SIG_HEX)}`.toLowerCase() === anchorSigOnChain.toLowerCase(), "the posted anchor signature is not the one on chain");
        const message = bytesToHex(roundSigBytes(rollupId, round, roundHash));
        const { result } = await readContract(io.rpc, PQC_VERIFY, precompileAbi, "pqcVerify", [pubkey, `0x${anchorSig.slice(2 + SIG_HEX)}`, message]);
        must(result === true, "pqcVerify returned false for the round signature.");
        return `Two-signature mode: empty anchor slot as expected; pqcVerify returned true for the round signature over round ${round}, hash ${roundHash}.`;
      });
      await step("feedContract", async () => {
        if (!priceFeed || !attestation) throw new NotYet("PriceFeed is not deployed yet, so this check waits.");
        const sigs = anchorSig ?? (twoSig ? undefined : anchorSigOnChain);
        if (!sigs) throw new NotYet("The feed does not carry the posted signatures yet.");
        const att = toAbiAttestation(attestation!, input.tamper);
        const { result } = await readContract(io.rpc, priceFeed!, priceFeedAbi, "verifyReceipt",
          [att, root, BigInt(anchor!.transaction_count), sigs]);
        must(result === true, input.tamper ? "verifyReceipt returned false: one median digit changed." : "verifyReceipt returned false.");
        return `PriceFeed ${priceFeed} returned true${twoSig ? " for anchorSig ‖ roundSig" : ""}.`;
      });
    }
    out.valid = true;
  } catch (e) {
    if (!(e instanceof CheckFailed)) throw e;
    for (const c of checks) if (c.state === "wait") c.state = "skip";
    emit();
  }
  return out;
}

function toAbiAttestation(a: AttestationJson, tamper = false) {
  const medians = a.medians.map(BigInt);
  if (tamper && medians.length) medians[0] = medians[0]! + 1n;
  return {
    round: BigInt(a.round), batchIndex: BigInt(a.batchIndex), inboxStart: BigInt(a.inboxStart), inboxEnd: BigInt(a.inboxEnd),
    closeHeight: BigInt(a.closeHeight), closeTime: BigInt(a.closeTime), feedIds: a.feedIds, medians, counts: a.counts,
    reportsRoot: a.reportsRoot, reportCount: a.reportCount,
  };
}

/** A curl line anyone can paste to repeat the pqcVerify call without this page. */
export const curlFor = (call: NonNullable<VerifyOutcome["call"]>, url: string) =>
  `curl -s ${url} -H 'content-type: application/json' -d '${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: call.to, data: call.data }, "latest"] })}'`;

