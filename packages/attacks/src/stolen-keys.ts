// Q-Day attack: the attacker has recovered the classical secp256k1 keys of three scouts (enough to own the
// median of five) but not their ML-DSA-87 keys. Every way it tries to push fETH = $1 is refused.
import { classifyEvmWindowRejection } from "@qorechain/evm/window";
import { pqSign, pqVerify, signPqLayer, verifyPqLayer } from "@qorechain/qoresign";
import { postRollupDataMsg } from "@qorechain/rdk";
import {
  REJECT, anchorSignBytes, deriveRound, phaseOf, roundHash, roundWindows, toAttestation, type InboxEntry, type RoundParams,
} from "@sealed-scouts/core";
import { ScoutEligibility, chain as defaultChain, loadAccount, registry, wrapAccount, type Chain } from "@sealed-scouts/chain";
import { loadDeployment, registeredKemKey, timingOf, useDemo, type Deployment } from "@sealed-scouts/scout";
import { PRICE_FEED_ABI, SimRollup, simIdentity } from "@sealed-scouts/watchtower";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { errorEvidence, type Step } from "./evidence.js";
import { ONE_DOLLAR, forgedReport } from "./forge.js";

const A = "stolen-keys";
const VICTIMS = ["SCOUT1", "SCOUT2", "SCOUT3"] as const;

/** The anchor bytes the feed checks, for a forged round claiming fETH = $1. */
function forgedAnchor(chainId: string, rollupId: string, evmChainId: bigint, round: bigint, batchIndex: bigint) {
  const att = toAttestation(
    { round, status: "ok", leaves: [], medians: [{ feedId: 1, price: ONE_DOLLAR, count: 3 }], reportsRoot: `0x${"00".repeat(32)}`, outliers: [], inBand: [], rejected: [], skippedByOpener: [], openHeight: 0n, closeHeight: 0n },
    { index: batchIndex, inboxStart: 0n, inboxEnd: 1n, closeTime: 1n },
  );
  const stateRoot = `0x${"00".repeat(32)}` as const;
  const bytes = anchorSignBytes({ chainId, layerId: rollupId, batchIndex: att.batchIndex, stateRoot, validatorSetHash: roundHash(att, { chainId: evmChainId, rollupId }), txCount: 1n });
  return { att, stateRoot, bytes };
}

export async function stolenKeysDryRun(): Promise<Step[]> {
  const sim = new SimRollup();
  const { chainId, rollupId } = sim.env;
  const attacker = simIdentity("attacker");
  const victims = sim.scouts.slice(0, 3);
  const steps: Step[] = [];
  const authInfoBytes = new Uint8Array([0x0a, 0x00]); // any auth info: the PQ layer covers it, whatever it holds

  for (const v of victims) {
    const forged = forgedReport({ chainId, rollupId, round: 0n, victim: v.address, attackerPq: attacker.keys, openerKemKey: sim.opener.mlkemPublicKey });
    const bodyBytes = registry.encodeTxBody({ messages: [forged.report, forged.commit].map((data) => postRollupDataMsg({ poster: v.address, rollupId, data })), memo: "" });
    const bare = verifyPqLayer({ chainId, bodyBytes, authInfoBytes, pqPublicKey: v.keys.pqc.publicKey });
    steps.push({ attack: A, step: `${v.label}: post $1 report signed with the stolen secp256k1 key only`, verdict: bare.valid ? "NOT REFUSED" : "REFUSED", where: "local check", evidence: { pqLayer: bare.reason ?? "valid", rule: "hybrid_signature_mode=required" } });
    const signed = signPqLayer({ chainId, bodyBytes, authInfoBytes, pqKey: attacker.keys.pqc });
    const wrong = verifyPqLayer({ chainId, bodyBytes: signed.bodyBytes, authInfoBytes, pqPublicKey: v.keys.pqc.publicKey });
    steps.push({ attack: A, step: `${v.label}: same post with the attacker's own ML-DSA-87 layer`, verdict: wrong.valid ? "NOT REFUSED" : "REFUSED", where: "local check", evidence: { pqLayer: wrong.reason ?? "valid" } });
  }

  // Even if such posts landed, the rollup would not count them: the COMMIT signature is not the scout's.
  sim.height = sim.params.genesisHeight + 5n;
  for (const v of victims) {
    const forged = forgedReport({ chainId, rollupId, round: 0n, victim: v.address, attackerPq: attacker.keys, openerKemKey: sim.opener.mlkemPublicKey });
    sim.post(v.address, [forged.report, forged.commit]);
  }
  const own = forgedReport({ chainId, rollupId, round: 0n, victim: attacker.address, attackerPq: attacker.keys, openerKemKey: sim.opener.mlkemPublicKey });
  sim.post(attacker.address, [own.report, own.commit]);
  sim.pqKeys.set(attacker.address, attacker.keys.pqc.publicKey); // registered, but not a scout
  const params: RoundParams = { ...sim.params, pqKeyOf: (s) => sim.pqKeys.get(s) };
  const result = deriveRound(sim.entries, 0n, params, (s) => sim.scouts.some((x) => x.address === s));
  for (const v of [...victims, attacker]) {
    const reason = result.rejected.find((r) => r.scout === v.address)?.reason ?? "counted";
    steps.push({ attack: A, step: `${v.label}: forged report reaches the round`, verdict: reason === "counted" ? "NOT REFUSED" : "REFUSED", where: "simulation", evidence: { deriveRound: reason } });
  }

  const operator = sim.operator;
  const { bytes } = forgedAnchor(chainId, rollupId, 9800n, 1n, 1n);
  const random = new Uint8Array(randomBytes(4627));
  const attackerSig = pqSign(attacker.keys.pqc.secretKey, bytes);
  for (const [what, sig] of [["a random signature", random], ["the attacker's ML-DSA-87 signature", attackerSig]] as const) {
    const ok = pqVerify(operator.keys.pqc.publicKey, bytes, sig);
    steps.push({ attack: A, step: `forged $1 round at the feed with ${what}`, verdict: ok ? "NOT REFUSED" : "REFUSED", where: "local check", evidence: { mldsa87Verify: ok, anchorBytes: bytes.length } });
  }
  return steps;
}

/** The chain's answer to a missing or foreign ML-DSA-87 layer: codespace pqc, or a log naming the PQ check. */
const PQ_LOG = /post-quantum|\bpqc?\b|hybrid|ml-dsa|dilithium/i;
export function nativeVerdict(r: { code: number; codespace: string; rawLog: string }): Step["verdict"] {
  if (r.code === 0) return "NOT REFUSED";
  return r.codespace === "pqc" || PQ_LOG.test(r.rawLog) ? "REFUSED" : "ERROR";
}

/** Only PriceFeed's ML-DSA-87 check counts; any other revert (stale round, unbonded operator) proves nothing. */
export function postRoundVerdict(revert: string | undefined): Step["verdict"] {
  return revert === undefined ? "NOT REFUSED" : revert === "BadSignature" ? "REFUSED" : "ERROR";
}

/** Only the EVM lane's "no open EVM authorisation window" counts. */
export function windowVerdict(e: unknown): Step["verdict"] {
  return classifyEvmWindowRejection(e) === "no-window" ? "REFUSED" : "ERROR";
}

/** Wait for a height with at least `margin` blocks left in a round's commit window; return that round. */
async function commitWindowRound(chain: Chain, timing: Parameters<typeof phaseOf>[1], margin = 10n): Promise<bigint> {
  for (;;) {
    const h = BigInt(await chain.inbox.rest.getLatestHeight());
    const { round, phase } = phaseOf(h, timing);
    if (phase === "commit" && h + margin < roundWindows(round, timing).commitEnd) return round;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

export async function stolenKeysLive(opts: { demo?: boolean; chain?: Chain } = {}): Promise<Step[]> {
  const chain = opts.chain ?? defaultChain();
  const d = needDeployment();
  const timing = timingOf(d, useDemo(d, opts.demo));
  const attacker = await loadAccount("ATTACKER");
  const opener = await registeredKemKey(chain, d.operator);
  const height = BigInt(await chain.inbox.rest.getLatestHeight());
  const { round } = phaseOf(height, timing);
  const steps: Step[] = [];
  const GAS = 900_000; // fixed, so nothing is simulated first: the chain itself answers

  for (const role of VICTIMS) {
    const victim = await loadAccount(role);
    // What the attacker holds: the victim's classical key. Its ML-DSA-87 key is the attacker's own.
    const stolen = wrapAccount("CUSTOM", { ...victim.keys, mnemonic: undefined, pqc: attacker.keys.pqc });
    const forged = forgedReport({ chainId: d.chainId, rollupId: d.rollupId, round, victim: victim.address, attackerPq: attacker.keys, openerKemKey: opener });
    const msgs = [forged.report, forged.commit].map((data) => postRollupDataMsg({ poster: victim.address, rollupId: d.rollupId, data }));
    for (const [mode, label] of [["classical", "secp256k1 only"], ["hybrid", "attacker's ML-DSA-87 layer"]] as const) {
      const step = `${role}: post $1 report, ${label}`;
      try {
        const r = await chain.native.send(stolen, msgs, { mode, gas: GAS });
        steps.push({ attack: A, step, verdict: nativeVerdict(r), where: "chain", evidence: { code: r.code, codespace: r.codespace, txHash: r.txHash, log: r.rawLog.slice(0, 160) } });
      } catch (e) {
        steps.push({ attack: A, step, verdict: "ERROR", where: "chain", evidence: errorEvidence(e) });
      }
    }
  }

  // From its own account the attacker can post: the chain orders anything. The rollup ignores it.
  // Post inside a commit window, so the round rejects it for eligibility and not merely for arriving late.
  const ownRound = await commitWindowRound(chain, timing);
  const own = forgedReport({ chainId: d.chainId, rollupId: d.rollupId, round: ownRound, victim: attacker.address, attackerPq: attacker.keys, openerKemKey: opener });
  const posted = await chain.native.postToInbox(attacker, [own.report, own.commit], d.rollupId).catch((e) => e as Error);
  if (posted instanceof Error) {
    steps.push({ attack: A, step: "ATTACKER: post $1 report from its own account", verdict: "ERROR", where: "chain", evidence: errorEvidence(posted) });
  } else {
    const entries: InboxEntry[] = posted.sequences.map((seq, i) => ({ seq, height: posted.height, poster: attacker.address, payload: [own.report, own.commit][i]! }));
    const pq = new Map([[attacker.address, attacker.keys.pqc.publicKey]]);
    // The operator's eligibility rule, read at the round's close (or now, if the round is still open).
    const eligibility = new ScoutEligibility(chain.evm.publicClient, d.scouts, d.priceFeed);
    const closeHeight = roundWindows(ownRound, timing).commitEnd;
    const snap = await eligibility.snapshot(ownRound, closeHeight < posted.height ? closeHeight : posted.height);
    if (snap.status === "unknown") {
      steps.push({ attack: A, step: "ATTACKER: post $1 report from its own account", verdict: "ERROR", where: "rollup", evidence: { txHash: posted.txHash, eligibility: snap.reason } });
    } else {
      const result = deriveRound(entries, ownRound, { ...timing, ...d.rules, chainId: d.chainId, rollupId: d.rollupId, operator: d.operator, pqKeyOf: (s) => pq.get(s) }, eligibility.eligible);
      const reason = result.rejected.find((r) => r.scout === attacker.address)?.reason ?? "counted";
      steps.push({ attack: A, step: "ATTACKER: post $1 report from its own account", verdict: reason === REJECT.notEligible ? "REFUSED" : "NOT REFUSED", where: "rollup", evidence: { txHash: posted.txHash, deriveRound: reason } });
    }
  }

  if (d.priceFeed) {
    const pc = chain.evm.publicClient;
    const feed = { address: d.priceFeed, abi: PRICE_FEED_ABI } as const;
    // The next round and batch the feed would take, so the attestation passes every check before the signature.
    const [lastRound, lastBatchIndex, started] = await pc.readContract({ ...feed, functionName: "cursor" });
    const twoSig = await pc.readContract({ ...feed, functionName: "twoSigMode" });
    const { att, stateRoot } = forgedAnchor(d.chainId, d.rollupId, BigInt(d.evmChainId), started ? lastRound + 1n : round, started ? lastBatchIndex + 1n : 1n);
    const sig = `0x${Buffer.from(randomBytes((twoSig ? 2 : 1) * 4627)).toString("hex")}` as const;
    const step = `forged $1 round ${att.round} (batch ${att.batchIndex}) at PriceFeed.postRound`;
    try {
      await pc.simulateContract({ ...feed, functionName: "postRound", args: [att, stateRoot, 1n, sig], account: attacker.evm });
      steps.push({ attack: A, step, verdict: "NOT REFUSED", where: "evm", evidence: {} });
    } catch (e) {
      const ev = errorEvidence(e);
      steps.push({ attack: A, step, verdict: postRoundVerdict(ev.revert), where: "evm", evidence: { ...ev, twoSig } });
    }
  }

  // An EVM transaction signed with a stolen key, without an EVM window opened by a hybrid native message.
  const victim = await loadAccount(VICTIMS[0]);
  const wallet = createWalletClient({ account: privateKeyToAccount(victim.keys.privateKey as `0x${string}`), chain: chain.evm.chain, transport: http(chain.config.evmRpc) });
  const step = `${VICTIMS[0]}: EVM transfer with the stolen key, no window`;
  try {
    const hash = await wallet.sendTransaction({ to: attacker.evm, value: 1n, gas: 21_000n });
    steps.push({ attack: A, step, verdict: "NOT REFUSED", where: "evm", evidence: { txHash: hash } });
  } catch (e) {
    steps.push({ attack: A, step, verdict: windowVerdict(e), where: "evm", evidence: { ...errorEvidence(e), window: classifyEvmWindowRejection(e) ?? "none" } });
  }
  return steps;
}

export function needDeployment(): Deployment {
  const d = loadDeployment();
  if (!d) throw new Error("deployments/diana.json is missing: the rollup is not launched yet (use --dry-run)");
  return d;
}

