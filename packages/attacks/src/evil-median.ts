// The operator itself lies: it posts a round whose fETH median is $1. The anchor signature is real, so PriceFeed
// accepts the round as Pending. The watchtower replays the round from inbox data, sees a different median and
// challenges; the court recomputes the median from the committed reports, corrects the price and slashes.
import { formatE8 } from "@sealed-scouts/scout";
import {
  FeedWriter, PRICE_FEED_ABI, Watchtower, buildDemoWorld, derive, feedRoundFor, liveChallenger, liveSource, simTowerConfig, towerConfigFrom,
} from "@sealed-scouts/watchtower";
import { chain as defaultChain, loadAccount, type Chain } from "@sealed-scouts/chain";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOND, CourtRevert, SimCourt } from "./court.js";
import { errorEvidence, type Step } from "./evidence.js";
import { needDeployment } from "./stolen-keys.js";

const A = "evil-median";
const quiet = () => {};

export async function evilMedianDryRun(): Promise<Step[]> {
  const { sim, wrongMedianRound: round } = buildDemoWorld();
  const tower = sim.scouts[0]!.address; // any address can challenge
  const court = new SimCourt(sim, tower);
  court.bonds.set(sim.operator.address, BOND);
  const posted = sim.feedRounds.get(round)!;
  const steps: Step[] = [
    { attack: A, step: `operator posts round ${round} with fETH = $${formatE8(posted.medians[0]!)}, anchor validly signed`, verdict: "ACCEPTED", where: "simulation", evidence: { status: posted.status, reportsRoot: posted.reportsRoot } },
  ];

  const watchtower = new Watchtower(simTowerConfig(sim.params), sim.asSource(), new FeedWriter(mkdtempSync(join(tmpdir(), "ss-evil-"))), court, quiet);
  await watchtower.sync();
  const c = watchtower.challenges.find((x) => x.target === `round ${round}`);
  const after = sim.feedRounds.get(round)!;
  steps.push({
    attack: A, step: `watchtower replays round ${round} and challenges the median`, verdict: after.status === "corrected" ? "REFUSED" : "NOT REFUSED", where: "simulation",
    evidence: { challengeTx: c?.txHash ?? "none", fETH: formatE8(after.medians[0]!), status: after.status, operatorBond: String(court.bonds.get(sim.operator.address)), toChallenger: String(court.paid.get(tower) ?? 0n), burned: String(court.burned) },
  });

  // A false challenge against an honest pending round is refused, and nobody is slashed.
  const honestRound = 5n;
  sim.feedRounds.set(honestRound, feedRoundFor(derive(sim, honestRound), "pending"));
  court.bonds.set(sim.operator.address, BOND);
  try {
    await court.challengeMedian(honestRound, derive(sim, honestRound).leaves);
    steps.push({ attack: A, step: `false challenge of honest round ${honestRound}`, verdict: "NOT REFUSED", where: "simulation", evidence: {} });
  } catch (e) {
    steps.push({ attack: A, step: `false challenge of honest round ${honestRound}`, verdict: e instanceof CourtRevert ? "REFUSED" : "NOT REFUSED", where: "simulation", evidence: { revert: (e as Error).message, operatorBond: String(court.bonds.get(sim.operator.address)) } });
  }
  return steps;
}

/**
 * Live: the operator loop must post one wrong round (see the operator's lie switch). This waits for a round whose
 * feed median differs from the replay, lets the active watchtower challenge it, and records the court's answer.
 */
export async function evilMedianLive(opts: { timeoutMs?: number; chain?: Chain } = {}): Promise<Step[]> {
  const chain = opts.chain ?? defaultChain();
  const d = needDeployment();
  if (!d.priceFeed) throw new Error("no PriceFeed address in the deployment");
  const tower = await loadAccount("TOWER");
  const watchtower = new Watchtower(
    towerConfigFrom(d),
    liveSource(chain, d.rollupId, d.priceFeed), new FeedWriter(mkdtempSync(join(tmpdir(), "ss-evil-"))), liveChallenger(chain, tower, d.rollupId, d.priceFeed),
  );
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    await watchtower.sync();
    const c = watchtower.challenges.find((x) => x.kind === "median");
    if (c) {
      const round = BigInt(c.target.replace("round ", ""));
      const status = await chain.evm.publicClient.readContract({ address: d.priceFeed, abi: PRICE_FEED_ABI, functionName: "status", args: [round] });
      const [price] = await chain.evm.publicClient.readContract({ address: d.priceFeed, abi: PRICE_FEED_ABI, functionName: "points", args: [round, 1] });
      return [{
        attack: A, step: `operator's wrong median in round ${round} challenged`, verdict: Number(status) === 3 ? "REFUSED" : "NOT REFUSED", where: "evm",
        claim: { id: "court-slash", layer: "evm", txKey: "challengeTx" },
        evidence: { challengeTx: c.txHash ?? "", ...(c.error ? errorEvidence(new Error(c.error)) : {}), feedStatus: Number(status), fETH: formatE8(price) },
      }];
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error("no wrong median appeared before the timeout: is the operator's lie switch on?");
}
