// A bonded submitter posts a ledger batch with a wrong state root. The watchtower re-executes the batch with the
// RDK's qledger code, builds the fraud proof, and the chain re-runs it: the batch is rejected and the bond slashed.
import { bondRollupSubmitterMsg, bytesToHex, planQledgerBatch, submitBatchMsg } from "@qorechain/rdk";
import { chain as defaultChain, loadAccount, type Chain } from "@sealed-scouts/chain";
import { FeedWriter, LedgerReplay, SimRollup, Watchtower, liveChallenger, liveSource, simTowerConfig, towerConfigFrom } from "@sealed-scouts/watchtower";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOND, SimCourt } from "./court.js";
import type { Step } from "./evidence.js";
import { useDemo } from "@sealed-scouts/scout";
import { needDeployment } from "./stolen-keys.js";

const A = "bad-batch";
const feedDir = () => mkdtempSync(join(tmpdir(), "ss-batch-"));

export async function badBatchDryRun(): Promise<Step[]> {
  const sim = new SimRollup();
  const scout = sim.scouts[0]!;
  sim.deposit(sim.operatorLedger.accountId, 5_000_000n);
  sim.submitBatch();
  sim.pay(new Uint8Array(32).fill(1), 250_000n);
  const bad = sim.submitBatch({ tamper: true });
  const court = new SimCourt(sim, scout.address);
  court.bonds.set(`submitter:${bad.batchIndex}`, BOND);
  const steps: Step[] = [
    { attack: A, step: `bonded submitter posts batch ${bad.batchIndex} with a wrong state root`, verdict: "ACCEPTED", where: "simulation", evidence: { stateRoot: bad.stateRoot.slice(0, 18) } },
  ];
  const proof = new LedgerReplay(sim.env).replay(sim.batches, sim.entries).find((b) => b.verdict === "fraud")!.proof!;
  const tower = new Watchtower(simTowerConfig(sim.params), sim.asSource(), new FeedWriter(feedDir()), court, () => {});
  await tower.sync();
  const c = tower.challenges.find((x) => x.kind === "batch");
  steps.push({
    attack: A, step: "watchtower re-executes the batch and sends the fraud proof", verdict: sim.batches[bad.batchIndex]!.status === "rejected" ? "REFUSED" : "NOT REFUSED", where: "simulation",
    evidence: { checkQledgerFraud: c?.code === 0, batchStatus: sim.batches[bad.batchIndex]!.status, bondLeft: String(court.bonds.get(`submitter:${bad.batchIndex}`)), toChallenger: String(court.paid.get(scout.address) ?? 0n), burned: String(court.burned) },
  });
  // The honest resubmission cannot be knocked out with the same proof.
  const good = sim.submitBatch();
  const r = await court.challengeBatch(good.batchIndex, proof);
  steps.push({ attack: A, step: `fraud proof replayed against honest batch ${good.batchIndex}`, verdict: r.code !== 0 ? "REFUSED" : "NOT REFUSED", where: "simulation", evidence: { code: r.code, batchStatus: good.status } });
  return steps;
}

export async function badBatchLive(opts: { bond?: boolean; demo?: boolean; chain?: Chain } = {}): Promise<Step[]> {
  const chain = opts.chain ?? defaultChain();
  const d = needDeployment();
  const rest = chain.inbox.rest;
  const rogue = await loadAccount("ROGUE");
  const steps: Step[] = [];

  const bond = BigInt((await rest.getSubmitterBond(d.rollupId, rogue.address)).amount);
  const min = BigInt((await rest.getParams()).minSubmitterBond ?? BOND);
  if (bond < min) {
    if (!opts.bond) throw new Error(`ROGUE has ${bond} uqor bonded, needs ${min}: rerun with --bond to lock it (it will be slashed)`);
    const r = await chain.native.sendOrThrow(rogue, [bondRollupSubmitterMsg({ submitter: rogue.address, rollupId: d.rollupId, amount: min - bond })]);
    steps.push({ attack: A, step: "ROGUE bonds as a batch submitter", verdict: "ACCEPTED", where: "chain", evidence: { txHash: r.txHash, amount: String(min - bond) } });
  }

  // The parent state: replay every batch so far, as any watchtower can.
  const source = liveSource(chain, d);
  const replay = new LedgerReplay(d);
  const head = await source.inboxHead();
  replay.replay(await source.batches(0), head > 0n ? await source.readInbox(1n, head) : []);
  // Sync the watchtower before the bad batch exists, so it only has the new batch to check: public challengers
  // watch every rollup, and the first valid fraud proof takes the reward.
  const tower = await loadAccount("TOWER");
  const watchtower = new Watchtower(
    towerConfigFrom(d, useDemo(d, opts.demo)),
    source, new FeedWriter(feedDir()), liveChallenger(chain, tower, d.rollupId, d.priceFeed),
  );
  await watchtower.sync();
  const plan = await planQledgerBatch(rest, { chainId: d.chainId, rollupId: d.rollupId, submitter: rogue.address, ledger: replay.state() });
  const wrongRoot = Uint8Array.from(plan.input.stateRoot, (b, i) => (i === 0 ? b ^ 0xff : b));
  const sub = await chain.native.sendOrThrow(rogue, [submitBatchMsg({ ...plan.input, sequencer: rogue.address, stateRoot: wrongRoot })]);
  steps.push({ attack: A, step: `ROGUE submits batch ${plan.input.batchIndex} with a wrong state root`, verdict: "ACCEPTED", where: "chain", evidence: { txHash: sub.txHash, stateRoot: bytesToHex(wrongRoot).slice(0, 16), honestRoot: bytesToHex(plan.input.stateRoot).slice(0, 16) } });

  const target = `batch ${plan.input.batchIndex}`;
  let c: (typeof watchtower.challenges)[number] | undefined;
  let after = await rest.getBatch(d.rollupId, plan.input.batchIndex);
  for (let i = 0; i < 40 && !c && after.status !== "rejected"; i++) {
    await watchtower.sync();
    c = watchtower.challenges.find((x) => x.target === target);
    if (!c) await new Promise((r) => setTimeout(r, 1_500));
    after = await rest.getBatch(d.rollupId, plan.input.batchIndex);
  }
  if (c?.txHash) for (let i = 0; i < 10 && after.status !== "rejected"; i++) {
    await new Promise((r) => setTimeout(r, 1_500));
    after = await rest.getBatch(d.rollupId, plan.input.batchIndex);
  }
  const bondAfter = (await rest.getSubmitterBond(d.rollupId, rogue.address)).amount;
  steps.push({
    attack: A, step: "watchtower sends MsgChallengeBatch with the qledger fraud proof", verdict: after.status === "rejected" ? "REFUSED" : "NOT REFUSED", where: "chain",
    // Only our own successful challenge backs the claim; a public challenger may get there first.
    ...(c?.txHash && !c.code ? { claim: { id: "chain-fraud-slash", layer: "native" as const, txKey: "challengeTx" } } : {}),
    evidence: { challengeTx: c?.txHash ?? "none", code: c?.code ?? -1, batchStatus: after.status, rogueBondLeft: bondAfter, ...(c?.error ? { error: c.error } : {}) },
  });
  return steps;
}
