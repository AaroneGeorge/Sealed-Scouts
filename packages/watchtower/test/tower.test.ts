import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkQledgerFraud } from "@qorechain/rdk";
import { pqVerify } from "@qorechain/qoresign";
import { anchorSignBytes, attestationFromJson, encodeMsg, fromHex, reportsRoot, roundHash, roundWindows, type Leaf } from "@sealed-scouts/core";
import { FeedWriter } from "../src/feed.js";
import { buildDemoWorld } from "../src/scenario.js";
import { simTowerConfig, sourceFromJson } from "../src/sim.js";
import type { Challenger } from "../src/source.js";
import { Watchtower } from "../src/tower.js";

const world = buildDemoWorld();
const { sim } = world;
const cfg = simTowerConfig(sim.params);

function recordingChallenger() {
  const medians: { round: bigint; leaves: Leaf[] }[] = [];
  const batches: { batchIndex: number; proof: Uint8Array }[] = [];
  const c: Challenger = {
    challengeMedian: async (round, leaves) => (medians.push({ round, leaves }), { txHash: `0xm${round}` }),
    challengeBatch: async (batchIndex, proof) => (batches.push({ batchIndex, proof }), { txHash: `B${batchIndex}`, code: 0 }),
  };
  return { c, medians, batches };
}

const feedDir = () => mkdtempSync(join(tmpdir(), "ss-feed-"));
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("Watchtower on the simulated demo history", () => {
  it("observe mode: replays everything, sends nothing, writes the feed", async () => {
    const dir = feedDir();
    const tower = new Watchtower(cfg, sim.asSource(), new FeedWriter(dir), undefined, () => {});
    await tower.sync();
    const status = readJson(join(dir, "status.json"));
    expect(status.mode).toBe("observe");
    expect(status.rounds).toMatchObject({ replayed: 6, match: 5, medianWrong: 1, rootWrong: 0 });
    expect(status.batches).toMatchObject({ replayed: 7, ok: 6, fraud: 1 });
    expect(status.operatorOmissions).toBe(1);
    expect(status.challenges.every((c: { sent: boolean }) => !c.sent)).toBe(true);

    const r2 = readJson(join(dir, "rounds", "2.json"));
    expect(r2.verdict).toBe("match");
    expect(r2.operator.leftOut).toEqual([{ scout: sim.scouts[4]!.address, how: "revealed" }]);
    expect(r2.reports).toHaveLength(5);
    expect(r2.reports[0].reportBytes).toBeGreaterThan(1_700);
    const r3 = readJson(join(dir, "rounds", "3.json"));
    expect(r3.outliers).toHaveLength(1);
  });

  it("each round file carries the posted attestation and the round hash the anchor signs", async () => {
    const dir = feedDir();
    await new Watchtower(cfg, sim.asSource(), new FeedWriter(dir), undefined, () => {}).sync();
    for (let round = 0n; round < 6n; round++) {
      const f = readJson(join(dir, "rounds", `${round}.json`));
      const posted = sim.feedRounds.get(round)!.attestation!;
      expect(attestationFromJson(f.attestation)).toEqual(posted);
      expect(f.roundHash).toBe(roundHash(posted, { chainId: 9800n, rollupId: sim.params.rollupId }));
      expect(f.attestation.batchIndex).toBe(f.feed.batchIndex);
      expect(f.feed.attestation).toBeUndefined();
      // postRound's other arguments are there too, and the anchor signature covers this round hash.
      expect(f.twoSig).toBe(false);
      const anchor = anchorSignBytes({ chainId: sim.params.chainId, layerId: sim.params.rollupId, batchIndex: posted.batchIndex, stateRoot: f.stateRoot, validatorSetHash: f.roundHash, txCount: BigInt(f.txCount) });
      expect(pqVerify(sim.operator.keys.pqc.publicKey, anchor, fromHex(f.anchorSig))).toBe(true);
      const b = sim.batches[Number(posted.batchIndex)]!;
      expect([BigInt(b.inboxStart), BigInt(b.inboxEnd), b.status]).toEqual([posted.inboxStart, posted.inboxEnd, "submitted"]);
      if (round > 0n) expect(posted.batchIndex).toBeGreaterThan(sim.feedRounds.get(round - 1n)!.batchIndex); // one round per batch
    }
    // The lying round's file shows the $1 the operator signed, next to the replayed median.
    const evil = readJson(join(dir, "rounds", `${world.wrongMedianRound}.json`));
    expect(evil.attestation.medians[0]).toBe("100000000");
    expect(evil.medians[0].price).not.toBe("100000000");
  });

  it("active mode: challenges the wrong median with leaves that hash to the posted root, once", async () => {
    const { c, medians, batches } = recordingChallenger();
    const tower = new Watchtower(cfg, sim.asSource(), new FeedWriter(feedDir()), c, () => {});
    await tower.sync();
    await tower.sync();
    expect(medians.map((m) => m.round)).toEqual([world.wrongMedianRound]);
    expect(reportsRoot(medians[0]!.leaves)).toBe(sim.feedRounds.get(world.wrongMedianRound)!.reportsRoot);
    expect(batches.map((b) => b.batchIndex)).toEqual([world.fraudBatch]);
    expect(checkQledgerFraud(sim.env, sim.batches[world.fraudBatch]!, batches[0]!.proof)).toBe(true);
    expect(tower.challenges.map((x) => [x.target, x.sent])).toEqual([[`round ${world.wrongMedianRound}`, true], [`batch ${world.fraudBatch}`, true]]);
  });

  it("does not challenge a round that is already final", async () => {
    sim.feedRounds.get(world.wrongMedianRound)!.status = "final";
    const { c, medians } = recordingChallenger();
    await new Watchtower(cfg, sim.asSource(), new FeedWriter(feedDir()), c, () => {}).sync();
    expect(medians).toEqual([]);
    sim.feedRounds.get(world.wrongMedianRound)!.status = "pending";
  });

  it("a recorded simulation (JSON) gives the same verdicts as the live object", async () => {
    const recorded = sourceFromJson(JSON.parse(JSON.stringify(sim.toJSON())));
    const tower = new Watchtower(simTowerConfig(recorded.params), recorded.source, new FeedWriter(feedDir()), undefined, () => {});
    await tower.sync();
    expect(tower.status().rounds).toMatchObject({ match: 5, medianWrong: 1 });
    expect(tower.status().batches).toMatchObject({ fraud: 1 });
    expect(await recorded.source.feedRound(1n)).toEqual(sim.feedRounds.get(1n));
  });

  it("ignores rounds whose reveal window is still open", async () => {
    const source = { ...sim.asSource(), height: async () => sim.params.genesisHeight + 10n };
    const tower = new Watchtower(cfg, source, new FeedWriter(feedDir()), undefined, () => {});
    await tower.sync();
    expect(tower.status().rounds.replayed).toBe(0);
  });
});

describe("eligibility from the source (the operator's rule)", () => {
  it("asks once per check at the round's close height and applies the answer", async () => {
    const asked: [bigint, bigint][] = [];
    const banned = sim.scouts[0]!.address;
    const source = {
      ...sim.asSource(),
      eligibility: async (round: bigint, closeHeight: bigint) => {
        asked.push([round, closeHeight]);
        return (scout: string) => scout !== banned;
      },
    };
    const dir = feedDir();
    await new Watchtower(cfg, source, new FeedWriter(dir), undefined, () => {}).sync();
    expect(asked[0]).toEqual([0n, sim.params.genesisHeight + sim.params.commitBlocks]);
    const r0 = readJson(join(dir, "rounds", "0.json"));
    expect(r0.rejected).toContainEqual({ scout: banned, reason: "not-eligible" });
    expect(r0.verdict).toBe("root-wrong"); // the feed was posted with five reports; this rule counts four
  });
});

describe("one bad round cannot stall the tower", () => {
  it("a post claiming an old round is ignored: rounds come from heights, not from what a message says", async () => {
    const { sim: s } = buildDemoWorld();
    const asked: bigint[] = [];
    // An attacker posts a REPORT claiming round 0, long after round 0; and one claiming a round before genesis.
    s.post(s.scouts[0]!.address, [encodeMsg({ kind: "REPORT", round: 0n, envelope: new Uint8Array(32) })]);
    s.height += 10n;
    const source = {
      ...s.asSource(),
      eligibility: async (round: bigint) => {
        asked.push(round);
        return () => true;
      },
    };
    const tower = new Watchtower(simTowerConfig(s.params), source, new FeedWriter(feedDir()), undefined, () => {});
    await tower.sync();
    expect(asked).toEqual([0n, 1n, 2n, 3n, 4n, 5n]);
    expect(tower.status().rounds.replayed).toBe(6);
    expect(tower.status().batches).toMatchObject({ replayed: 7, fraud: 1 });
  });

  it("a round whose chain reads fail is published as unknown; other rounds and every batch are still checked", async () => {
    const { sim: s, wrongMedianRound } = buildDemoWorld();
    let failing = true;
    const source = {
      ...s.asSource(),
      eligibility: async (round: bigint) => {
        if (round === 0n && failing) throw new Error("historical eth_call failed: state not available");
        return () => true;
      },
    };
    const { c, medians, batches } = recordingChallenger();
    const dir = feedDir();
    const tower = new Watchtower(simTowerConfig(s.params), source, new FeedWriter(dir), c, () => {});
    await tower.sync();
    expect(readJson(join(dir, "rounds", "0.json"))).toMatchObject({ round: "0", verdict: "unknown" });
    expect(tower.status().rounds).toMatchObject({ unknown: 1, replayed: 5 });
    expect(medians.map((m) => m.round)).toEqual([wrongMedianRound]);
    expect(batches).toHaveLength(1);
    failing = false; // retried next pass
    await tower.sync();
    expect(tower.status().rounds).toMatchObject({ unknown: 0, replayed: 6 });
    expect(readJson(join(dir, "rounds", "0.json")).verdict).toBe("match");
  });
});

describe("a round range (what the judge runs)", () => {
  it("reads only the range's part of the inbox, judges only its rounds, and skips the ledger", async () => {
    const reads: [bigint, bigint][] = [];
    const base = sim.asSource();
    const source = { ...base, readInbox: async (from: bigint, to: bigint) => (reads.push([from, to]), base.readInbox(from, to)) };
    const dir = feedDir();
    const tower = new Watchtower({ ...cfg, rounds: { from: 2n, to: 3n }, ledger: false }, source, new FeedWriter(dir), undefined, () => {});
    await tower.sync();
    const w2 = roundWindows(2n, sim.params);
    const w3 = roundWindows(3n, sim.params);
    const [from, to] = reads[0]!;
    expect(sim.entries.find((e) => e.seq === from)!.height).toBeGreaterThanOrEqual(w2.start);
    expect(sim.entries.find((e) => e.seq === from - 1n)!.height).toBeLessThan(w2.start);
    expect(sim.entries.find((e) => e.seq === to)!.height).toBeLessThan(w3.revealEnd);
    expect(readdirSync(join(dir, "rounds")).sort()).toEqual(["2.json", "3.json"]);
    expect(readJson(join(dir, "rounds", "2.json")).verdict).toBe("match");
    expect(tower.status().batches.replayed).toBe(0);
  });

  it("refuses a range with the ledger replay on (it would judge batches on a partial inbox)", () => {
    expect(() => new Watchtower({ ...cfg, rounds: { from: 0n, to: 1n } }, sim.asSource(), new FeedWriter(feedDir()))).toThrow(/ledger/);
  });
});
