// Q-Day attack: the attacker has recovered the classical secp256k1 keys of three scouts (enough to own the
// median of five) but not their ML-DSA-87 keys. Every way it tries to push fETH = $1 is refused.
import { pqSign, pqVerify, signPqLayer, verifyPqLayer } from "@qorechain/qoresign";
import { postRollupDataMsg } from "@qorechain/rdk";
import {
  REJECT, anchorSignBytes, deriveRound, phaseOf, roundHash, roundWindows, toAttestation, type InboxEntry, type RoundParams,
} from "@sealed-scouts/core";
import { ScoutEligibility, chain as defaultChain, loadAccount, registry, wrapAccount, type Chain } from "@sealed-scouts/chain";
import { loadDeployment, registeredKemKey, type Deployment } from "@sealed-scouts/scout";
import { PRICE_FEED_ABI, SimRollup, simIdentity } from "@sealed-scouts/watchtower";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { errorEvidence, type Step } from "./evidence.js";
import { ONE_DOLLAR, forgedReport } from "./forge.js";

const A = "stolen-keys";
const VICTIMS = ["SCOUT1", "SCOUT2", "SCOUT3"] as const;

/** The anchor bytes the feed checks, for a forged round claiming fETH = $1. */
function forgedAnchor(chainId: string, rollupId: string, evmChainId: bigint, round: bigint) {
  const att = toAttestation(
    { round, status: "ok", leaves: [], medians: [{ feedId: 1, price: ONE_DOLLAR, count: 3 }], reportsRoot: `0x${"00".repeat(32)}`, outliers: [], inBand: [], rejected: [], skippedByOpener: [], openHeight: 0n, closeHeight: 0n },
    { index: 1n, inboxStart: 0n, inboxEnd: 1n, closeTime: 1n },
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
  const { bytes } = forgedAnchor(chainId, rollupId, 9800n, 1n);
  const random = new Uint8Array(randomBytes(4627));
  const attackerSig = pqSign(attacker.keys.pqc.secretKey, bytes);
  for (const [what, sig] of [["a random signature", random], ["the attacker's ML-DSA-87 signature", attackerSig]] as const) {
    const ok = pqVerify(operator.keys.pqc.publicKey, bytes, sig);
    steps.push({ attack: A, step: `forged $1 round at the feed with ${what}`, verdict: ok ? "NOT REFUSED" : "REFUSED", where: "local check", evidence: { mldsa87Verify: ok, anchorBytes: bytes.length } });
  }
  return steps;
}

export async function stolenKeysLive(chain: Chain = defaultChain()): Promise<Step[]> {
  const d = needDeployment();
  const attacker = await loadAccount("ATTACKER");
  const opener = await registeredKemKey(chain, d.operator);
  const height = BigInt(await chain.inbox.rest.getLatestHeight());
  const { round } = phaseOf(height, d.timing);
  const steps: Step[] = [];
  const GAS = 900_000; // fixed, so nothing is simulated first: the chain itself answers

  for (const role of VICTIMS) {
    const victim = await loadAccount(role);
    // What the attacker holds: the victim's classical key. Its ML-DSA-87 key is the attacker's own.
    const stolen = wrapAccount("CUSTOM", { ...victim.keys, mnemonic: undefined, pqc: attacker.keys.pqc });
    const forged = forgedReport({ chainId: d.chainId, rollupId: d.rollupId, round, victim: victim.address, attackerPq: attacker.keys, openerKemKey: opener });
    const msgs = [forged.report, forged.commit].map((data) => postRollupDataMsg({ poster: victim.address, rollupId: d.rollupId, data }));
    for (const [mode, label] of [["classical", "secp256k1 only"], ["hybrid", "attacker's ML-DSA-87 layer"]] as const) {
      const r = await chain.native.send(stolen, msgs, { mode, gas: GAS }).catch((e) => ({ code: -1, codespace: "client", rawLog: String(e), txHash: "", height: 0n }));
      steps.push({ attack: A, step: `${role}: post $1 report, ${label}`, verdict: r.code === 0 ? "NOT REFUSED" : "REFUSED", where: "chain", evidence: { code: r.code, codespace: r.codespace, txHash: r.txHash, log: r.rawLog.slice(0, 160) } });
    }
  }

  // From its own account the attacker can post: the chain orders anything. The rollup ignores it.
  const own = forgedReport({ chainId: d.chainId, rollupId: d.rollupId, round, victim: attacker.address, attackerPq: attacker.keys, openerKemKey: opener });
  const posted = await chain.native.postToInbox(attacker, [own.report, own.commit], d.rollupId).catch((e) => e as Error);
  if (posted instanceof Error) {
    steps.push({ attack: A, step: "ATTACKER: post $1 report from its own account", verdict: "REFUSED", where: "chain", evidence: errorEvidence(posted) });
  } else {
    const entries: InboxEntry[] = posted.sequences.map((seq, i) => ({ seq, height: posted.height, poster: attacker.address, payload: [own.report, own.commit][i]! }));
    const pq = new Map([[attacker.address, attacker.keys.pqc.publicKey]]);
    // The operator's eligibility rule, read at the round's close (or now, if the round is still open).
    const eligibility = new ScoutEligibility(chain.evm.publicClient, d.scouts, d.priceFeed);
    const closeHeight = roundWindows(round, d.timing).commitEnd;
    await eligibility.snapshot(round, closeHeight < posted.height ? closeHeight : posted.height);
    const result = deriveRound(entries, round, { ...d.timing, ...d.rules, chainId: d.chainId, rollupId: d.rollupId, operator: d.operator, pqKeyOf: (s) => pq.get(s) }, eligibility.eligible);
    const reason = result.rejected.find((r) => r.scout === attacker.address)?.reason ?? "counted";
    steps.push({ attack: A, step: "ATTACKER: post $1 report from its own account", verdict: reason === REJECT.notEligible ? "REFUSED" : "NOT REFUSED", where: "rollup", evidence: { txHash: posted.txHash, deriveRound: reason } });
  }

  if (d.priceFeed) {
    const { att, stateRoot } = forgedAnchor(d.chainId, d.rollupId, BigInt(d.evmChainId), round);
    try {
      await chain.evm.publicClient.simulateContract({ address: d.priceFeed, abi: PRICE_FEED_ABI, functionName: "postRound", args: [att, stateRoot, 1n, `0x${Buffer.from(randomBytes(4627)).toString("hex")}`], account: attacker.evm });
      steps.push({ attack: A, step: "forged $1 round at PriceFeed.postRound", verdict: "NOT REFUSED", where: "evm", evidence: {} });
    } catch (e) {
      steps.push({ attack: A, step: "forged $1 round at PriceFeed.postRound", verdict: "REFUSED", where: "evm", evidence: errorEvidence(e) });
    }
  }

  // An EVM transaction signed with a stolen key, without an EVM window opened by a hybrid native message.
  const victim = await loadAccount(VICTIMS[0]);
  const wallet = createWalletClient({ account: privateKeyToAccount(victim.keys.privateKey as `0x${string}`), chain: chain.evm.chain, transport: http(chain.config.evmRpc) });
  try {
    const hash = await wallet.sendTransaction({ to: attacker.evm, value: 1n, gas: 21_000n });
    steps.push({ attack: A, step: `${VICTIMS[0]}: EVM transfer with the stolen key, no window`, verdict: "NOT REFUSED", where: "evm", evidence: { txHash: hash } });
  } catch (e) {
    steps.push({ attack: A, step: `${VICTIMS[0]}: EVM transfer with the stolen key, no window`, verdict: "REFUSED", where: "evm", evidence: errorEvidence(e) });
  }
  return steps;
}

export function needDeployment(): Deployment {
  const d = loadDeployment();
  if (!d) throw new Error("deployments/diana.json is missing: the rollup is not launched yet (use --dry-run)");
  return d;
}

