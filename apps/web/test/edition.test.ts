import { describe, expect, it } from "vitest";
import {
  allFlagged, batchFraudOf, challengeEvidence, evidenceRounds, checkTally, correctionOf, dateline, feedState, flaggedRounds, formatAge, formatChange, formatQor,
  fraudProofOf, fraudUpheldOf, gapBetween, gapLabel, gapMeansPause, isEvmTx, windowGaps, leadOf, pauseSpan, roundGaps, unpostedRuns, upheldRows, verdictOf, replayNote, roundHeadline, runCounts, seriesOf, spell, tickerOf,
} from "../src/lib/edition";
import type { AttackRun, TowerRound, TowerStatus } from "../src/lib/types";

type Summary = TowerStatus["latestRounds"][number];
const r = (round: string, over: Partial<Summary> = {}): Summary => ({
  round, verdict: "match", feedStatus: "final", reports: 3, leftOut: 0,
  medians: [{ feedId: 1, price: "176000000000", count: 3 }, { feedId: 3, price: "99930000", count: 3 }], ...over,
});
const status = (latestRounds: Summary[], over: Partial<TowerStatus> = {}) =>
  ({ rollupId: "sealed-scouts-1", latestRounds, challenges: [], rounds: { replayed: latestRounds.length }, ...over }) as TowerStatus;

describe("tickerOf", () => {
  it("gives each feed's change from the settled round before", () => {
    const s = status([
      r("1", { medians: [{ feedId: 1, price: "100000000000", count: 3 }, { feedId: 3, price: "99930000", count: 3 }] }),
      r("2", { verdict: "median-wrong" }), // not settled: skipped as a base
      r("3", { medians: [{ feedId: 1, price: "101000000000", count: 3 }, { feedId: 3, price: "99930000", count: 3 }] }),
      r("4", { feedStatus: "pending" }),
    ]);
    const t = tickerOf(s);
    expect(t.map((x) => [x.symbol, x.round, x.changeBps, x.prevRound])).toEqual([["fETH/USD", "3", 100, "1"], ["fUSD/USD", "3", 0, "1"]]);
  });
  it("has no change for the first settled round and nothing with none settled", () => {
    expect(tickerOf(status([r("1")]))[0]!.changeBps).toBeNull();
    expect(tickerOf(status([r("1", { feedStatus: "pending" })]))).toEqual([]);
  });
  it("formats changes the way a markets page does", () => {
    expect([formatChange(19), formatChange(-120), formatChange(0), formatChange(null)]).toEqual(["+0.19%", "−1.20%", "unch.", ""]);
  });
});

describe("seriesOf", () => {
  it("marks corrected, disputed and pending rounds", () => {
    const s = status([r("1"), r("2", { verdict: "corrected", feedStatus: "corrected" }), r("3", { verdict: "median-wrong", feedStatus: "pending" }), r("4", { feedStatus: "pending" }), r("5", { medians: [] })]);
    expect(seriesOf(s, 1).map((p) => [p.round, p.mark])).toEqual([["1", null], ["2", "corrected"], ["3", "disputed"], ["4", "pending"]]);
  });
});

describe("corrections", () => {
  it("finds flagged rounds in the window and challenge targets beyond it, newest first", () => {
    const s = status([r("26"), r("27", { verdict: "median-wrong", feedStatus: "pending" })], {
      challenges: [{ kind: "median", target: "round 5", at: "", sent: false }, { kind: "batch", target: "batch 3", at: "", sent: false }],
    });
    expect(flaggedRounds(s)).toEqual(["27", "5"]);
  });

  const round5 = {
    round: "5", verdict: "corrected", status: "ok",
    medians: [{ feedId: 1, price: "177372897300", count: 3 }, { feedId: 2, price: "6274920000000", count: 3 }],
    feed: { status: "corrected", feedIds: [1, 2], medians: ["177372897300", "6274920000000"], counts: [3, 3], reportsRoot: "0x", reportCount: 3, batchIndex: "5" },
    attestation: { feedIds: [1, 2], medians: ["100000000", "6274920000000"] },
  } as unknown as TowerRound;

  it("reads what was printed from the signed attestation once PriceFeed holds the fix", () => {
    expect(correctionOf(round5)).toEqual({
      round: "5", kind: "corrected", batchIndex: "5", feedStatus: "corrected",
      rows: [{ feedId: 1, printed: "100000000", correct: "177372897300", onFeed: "177372897300" }],
    });
  });

  it("calls a wrong median that is still on PriceFeed disputed", () => {
    const r4 = { ...round5, round: "4", verdict: "median-wrong", attestation: undefined,
      feed: { ...round5.feed!, status: "pending", medians: ["100000000", "6274920000000"] } } as TowerRound;
    const c = correctionOf(r4)!;
    expect(c.kind).toBe("disputed");
    expect(c.rows).toEqual([{ feedId: 1, printed: "100000000", correct: "177372897300", onFeed: "100000000" }]);
  });

  it("says nothing for an honest round or the could-not-read stub", () => {
    expect(correctionOf({ ...round5, verdict: "match", feed: { ...round5.feed!, status: "final" } })).toBeUndefined();
    expect(correctionOf({ round: "5", verdict: "unknown" } as TowerRound)).toBeUndefined();
  });

  it("does not repeat a corrected round's status as its replay verdict", () => {
    expect(replayNote("corrected", "corrected")).toBeNull();
    expect(replayNote("final", "match")?.text).toBe("replay matches the feed");
    expect(replayNote("pending", "median-wrong")?.tone).toBe("fail");
  });

  const TX_A = "0xa206be90e2456a234d6882dd1df2cc1e28b219cef5947e210fb3d983320a675a";
  const TX_B = `0x${"BE".repeat(32)}`;

  it("keeps a round named by live challenge evidence after the watchtower's list resets", () => {
    const runs: AttackRun[] = [
      { name: "evil-median", note: "Live testnet run (qorechain-diana).", at: "", steps: [
        { attack: "evil-median", step: "operator's wrong median in round 5 challenged", verdict: "REFUSED", where: "evm", evidence: { challengeTx: TX_A } },
        { attack: "evil-median", step: "round 7 challenged", verdict: "REFUSED", where: "evm", evidence: { challengeTx: "none" } },
      ] },
      { name: "evil-median", note: "DRY RUN: local", at: "", steps: [
        { attack: "evil-median", step: "wrong median in round 9 challenged", verdict: "REFUSED", where: "simulation", evidence: { challengeTx: TX_B } },
      ] },
    ];
    expect(evidenceRounds(runs)).toEqual(["5"]);
    expect(allFlagged(status([r("26"), r("27", { verdict: "median-wrong" })]), runs)).toEqual(["27", "5"]);
  });

  it("finds the challenge transaction for a round in the attack runs", () => {
    const runs: AttackRun[] = [
      { name: "evil-median", note: "Live testnet run (qorechain-diana).", at: "2026-11-19T19:03:13Z", steps: [
        { attack: "evil-median", step: "operator's wrong median in round 5 challenged", verdict: "REFUSED", where: "evm", evidence: { challengeTx: TX_A, feedStatus: 3 } },
        { attack: "evil-median", step: "round 50 challenged", verdict: "REFUSED", where: "evm", evidence: { challengeTx: TX_B } },
      ] },
    ];
    expect(challengeEvidence(runs, "5")).toEqual([
      { hash: TX_A, run: "evil-median", live: true, at: "2026-11-19T19:03:13Z", step: "operator's wrong median in round 5 challenged" },
    ]);
    expect(challengeEvidence(undefined, "5")).toEqual([]);
  });

  it("prints only full EVM transaction hashes as challenge transactions", () => {
    const step = (challengeTx: unknown) => ({ name: "x", note: "Live", at: "", steps: [
      { attack: "x", step: "round 5 challenged", verdict: "REFUSED" as const, where: "evm" as const, evidence: { challengeTx } as AttackRun["steps"][number]["evidence"] },
    ] });
    for (const bad of ["none", "", "0xa206", `${TX_A}00`, TX_A.slice(2), `0x${"zz".repeat(32)}`, 7]) {
      expect(challengeEvidence([step(bad)], "5")).toEqual([]);
    }
    expect(challengeEvidence([step(TX_B)], "5")).toHaveLength(1);
    expect([isEvmTx(TX_A), isEvmTx(TX_B), isEvmTx("none"), isEvmTx(undefined)]).toEqual([true, true, false, false]);
  });

  it("words the verdict from the setting the run used", () => {
    const checks = [{ state: "pass" as const }, { state: "pass" as const }];
    expect(verdictOf(true, checks, false)).toEqual({ word: "Receipt valid", tally: "2 passed" });
    expect(verdictOf(false, [{ state: "pass" as const }, { state: "fail" as const }], true))
      .toEqual({ word: "Receipt refused", tally: "1 passed, 1 failed; one digit was changed before checking" });
  });
});

describe("leadOf", () => {
  it("writes the headline from the newest settled round and notes a newer unsettled one", () => {
    const l = leadOf(status([r("34"), r("35", { feedStatus: "pending" })]));
    expect(l.headline).toBe("fETH settles at $1,760.00 in round 34");
    expect(l.deck).toMatch(/^Three sealed reports were opened/);
    expect(l.deck).toMatch(/Round 35 is still pending on PriceFeed\.$/);
  });
  it("says so when a correction set the price", () => {
    expect(leadOf(status([r("5", { verdict: "corrected", feedStatus: "corrected" })])).headline).toMatch(/after round 5 was corrected$/);
  });
  it("claims nothing when no round has settled", () => {
    const l = leadOf(status([r("1", { feedStatus: "pending" })]));
    expect(l.headline).toBe("No price has settled yet");
    expect(l.deck).toMatch(/one round;/);
  });
  it("spells small numbers", () => expect([spell(0), spell(3), spell(12)]).toEqual(["no", "three", "12"]));
});

describe("roundHeadline", () => {
  const base = {
    round: "35", verdict: "match", reports: [{ scout: "q", reportBytes: 1, commitBytes: 1, height: "1", counted: true }], leaves: [{}],
    medians: [{ feedId: 1, price: "176279676100", count: 3 }],
    feed: { status: "final", feedIds: [1], medians: ["176279676100"], counts: [3], reportsRoot: "0x", reportCount: 3, batchIndex: "35" },
  } as unknown as TowerRound;
  it("names a final price", () => expect(roundHeadline(base)).toBe("Round 35: fETH final at $1,762.79"));
  it("says corrected once a correction landed", () =>
    expect(roundHeadline({ ...base, verdict: "corrected", feed: { ...base.feed!, status: "corrected" } })).toBe("Round 35: a wrong median was challenged and corrected"));
  it("calls a wrong median disputed until then", () =>
    expect(roundHeadline({ ...base, verdict: "median-wrong", feed: { ...base.feed!, status: "pending" } })).toMatch(/disputes/));
  it("does not claim a price for a pending or unposted round", () => {
    expect(roundHeadline({ ...base, feed: { ...base.feed!, status: "pending" } })).toBe("Round 35: fETH posted at $1,762.79, pending");
    expect(roundHeadline({ ...base, verdict: "not-posted", feed: null })).toBe("Round 35: opened, not yet posted to PriceFeed");
  });
});

describe("bad batch", () => {
  const live = "Live testnet run (qorechain-diana).";
  const run2: AttackRun = { name: "bad-batch", note: live, at: "2026-11-20T12:44:29.074Z", steps: [
    { attack: "bad-batch", step: "ROGUE bonds as a batch submitter", verdict: "ACCEPTED", where: "chain", evidence: { txHash: "D03E", amount: "1000000000" } },
    { attack: "bad-batch", step: "ROGUE submits batch 36 with a wrong state root", verdict: "ACCEPTED", where: "chain",
      evidence: { txHash: "541B", stateRoot: "f4ab2ea726d24c0d", honestRoot: "0bab2ea726d24c0d" } },
    { attack: "bad-batch", step: "watchtower sends MsgChallengeBatch with the qledger fraud proof", verdict: "REFUSED", where: "chain",
      evidence: { challengeTx: "2E65", code: 0, batchStatus: "rejected", rogueBondLeft: "0" } },
  ] };
  const run1: AttackRun = { name: "bad-batch run 1", note: `${live} Lost the race: a public network challenger proved the fraud first.`, at: "2026-11-20T12:38:39Z", steps: [
    { attack: "bad-batch run 1", step: "ROGUE submits batch 36 with a wrong state root", verdict: "ACCEPTED", where: "chain", evidence: { txHash: "EB40", stateRoot: "f4ab", honestRoot: "0bab" } },
    { attack: "bad-batch run 1", step: "a public network challenger (not ours) sends MsgChallengeBatch first", verdict: "REFUSED", where: "chain",
      evidence: { txHash: "2F22", challenger: "qor1ua2d", batchStatus: "rejected" } },
  ] };

  it("does not count a run someone else's challenge won", () => {
    expect(runCounts(run2)).toBe(true);
    expect(runCounts(run1)).toBe(false);
    expect(runCounts({ ...run1, note: live })).toBe(false); // the step alone says "not ours"
  });

  it("takes the counted run's transactions from the evidence", () => {
    expect(batchFraudOf([run1, run2])).toEqual({
      run: "bad-batch", at: "2026-11-20T12:44:29.074Z", batchIndex: "36", bondTx: "D03E", bondAmount: "1000000000",
      submitTx: "541B", stateRoot: "f4ab2ea726d24c0d", honestRoot: "0bab2ea726d24c0d", challengeTx: "2E65", batchStatus: "rejected", bondLeft: "0",
    });
    expect(batchFraudOf([run1])).toBeUndefined();
    expect(batchFraudOf([{ ...run2, note: "DRY RUN: local checks" }])).toBeUndefined();
  });

  it("reads the chain's verdict from the challenge transaction", () => {
    const attrs = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));
    const tx = { tx_response: { height: "10433463", code: 0, events: [
      { type: "rdk_inbox_rolled_back", attributes: attrs({ rollup_id: "sealed-scouts-1" }) },
      { type: "rdk_fraud_upheld", attributes: attrs({ batch_index: "36", challenger: "qor1rya9", slashed: "1000000000uqor", challenger_reward: "500000000uqor", burned: "500000000uqor" }) },
    ] } };
    expect(fraudUpheldOf(tx)).toEqual({ height: "10433463", batchIndex: "36", slashed: "1000000000uqor", reward: "500000000uqor", burned: "500000000uqor", challenger: "qor1rya9" });
    expect(fraudUpheldOf({ tx_response: { height: "1", events: [] } })).toBeUndefined();
    expect(fraudUpheldOf(undefined)).toBeUndefined();
    // A failed transaction proves nothing, even if it somehow carried the event.
    expect(fraudUpheldOf({ tx_response: { ...tx.tx_response, code: 5 } })).toBeUndefined();
    expect(fraudProofOf(tx).state).toBe("upheld");
    expect(fraudProofOf({ tx_response: { height: "9", code: 5, events: [] } })).toEqual({ state: "not-upheld", code: 5 });
    expect(fraudProofOf({ tx_response: { height: "9", code: 0, events: [] } })).toEqual({ state: "not-upheld", code: 0 });
    expect(fraudProofOf(undefined)).toEqual({ state: "unread" });
  });

  it("formats uqor", () => {
    expect([formatQor("1000000000uqor"), formatQor("600000"), formatQor("1500000"), formatQor("x")]).toEqual(["1,000 QOR", "0.6 QOR", "1.5 QOR", undefined]);
  });
});

describe("round gaps and pauses", () => {
  it("finds any number of gaps", () => {
    expect(roundGaps(["33", "34", "35", "506", "507", "690", "940"])).toEqual([
      { before: "35", after: "506", from: "36", to: "505", missing: 470 },
      { before: "507", after: "690", from: "508", to: "689", missing: 182 },
      { before: "690", after: "940", from: "691", to: "939", missing: 249 },
    ]);
    expect(roundGaps(["1", "2", "3"])).toEqual([]);
    expect(roundGaps([])).toEqual([]);
    expect(gapLabel(roundGaps(["4", "6"])[0]!)).toBe("No round 5");
    expect(gapLabel(roundGaps(["35", "506"])[0]!)).toBe("No rounds 36–505");
  });

  it("takes gaps from every replayed round, not one feed's chart points", () => {
    // Round 507 has no fETH median, so a chart of fETH would see 506 -> 508; the table lists 507, so there is no gap.
    const s = status([r("506"), r("507", { medians: [] }), r("508"), r("600")]);
    const gaps = windowGaps(s);
    expect(gaps).toEqual([{ before: "508", after: "600", from: "509", to: "599", missing: 91 }]);
    expect(gapBetween(gaps, "506", "508")).toBeUndefined();
    expect(gapBetween(gaps, "508", "600")?.from).toBe("509");
    expect(gapBetween(gaps, "506", "600")?.from).toBe("509"); // a chart point skipping 508 still sees the gap
  });

  it("names a pause as the cause only in the demo round mode", () => {
    expect([gapMeansPause("demo"), gapMeansPause("standard"), gapMeansPause(undefined)]).toEqual([true, false, false]);
  });

  it("dates a pause only from what the round files carry", () => {
    const before = { closeHeight: "10391574", attestation: { closeTime: "1795118757" } } as TowerRound;
    const after = { openHeight: "10433919" } as TowerRound; // not posted: no attestation, no time
    expect(pauseSpan(before, after)).toEqual({ fromHeight: "10391574", toHeight: "10433919", fromTime: "2026-11-19T20:05:57.000Z", toTime: undefined });
    expect(pauseSpan(undefined, undefined)).toEqual({ fromHeight: undefined, toHeight: undefined, fromTime: undefined, toTime: undefined });
  });

  it("finds runs of rounds the operator never posted and moved past", () => {
    const s = status([
      r("35"), r("506", { verdict: "not-posted", feedStatus: "none" }), r("507", { verdict: "not-posted", feedStatus: "none" }),
      r("508", { verdict: "not-posted", feedStatus: null }), r("515"), r("516", { verdict: "not-posted", feedStatus: "none" }),
    ]);
    // 516 may still be posted, so it is not in a run yet.
    expect(unpostedRuns(s)).toEqual([["506", "508"]]);
    expect(unpostedRuns(status([r("1", { verdict: "not-posted", feedStatus: null })]))).toEqual([]);
  });
});

describe("upheld fraud proofs", () => {
  const up = (challenger: string, txHash: string) =>
    ({ batchIndex: 36, submitter: "qor1rogue", challenger, slashedUqor: "1000000000", challengerRewardUqor: "500000000", txHash, height: "1", time: "t" });
  const counted: AttackRun = { name: "bad-batch", note: "Live testnet run (qorechain-diana).", at: "", steps: [
    { attack: "bad-batch", step: "ROGUE submits batch 36 with a wrong state root", verdict: "ACCEPTED", where: "chain", evidence: { txHash: "541B", stateRoot: "f", honestRoot: "0" } },
    { attack: "bad-batch", step: "watchtower sends MsgChallengeBatch", verdict: "REFUSED", where: "chain", evidence: { challengeTx: "2e65", batchStatus: "rejected" } },
  ] };
  const run1: AttackRun = { name: "bad-batch run 1", note: "Live testnet run. Lost the race.", at: "", steps: [
    { attack: "bad-batch run 1", step: "a public network challenger (not ours) sends MsgChallengeBatch first", verdict: "REFUSED", where: "chain",
      evidence: { txHash: "2F22", challenger: "qor1public" } },
  ] };

  it("marks ours by the counted run's transaction and names the public challenger from the evidence", () => {
    const rows = upheldRows([up("qor1public", "2F22"), up("qor1tower", "2E65"), up("qor1x", "AAAA")], [counted, run1]);
    expect(rows.map((x) => [x.ours, x.who])).toEqual([[false, "a public network challenger"], [true, "our watchtower"], [false, "another challenger"]]);
  });
  it("stays neutral while the runs are loading or failed", () => {
    const rows = upheldRows([up("qor1public", "2F22"), up("qor1tower", "2E65")], undefined);
    expect(rows.map((x) => [x.ours, x.who])).toEqual([[undefined, undefined], [undefined, undefined]]);
  });
  it("stays neutral when there is no counted bad-batch run", () => {
    // Only run 1 (not counted) and the evil-median run: no basis to call any proof ours or not ours.
    const evil: AttackRun = { name: "evil-median", note: "Live testnet run.", at: "", steps: [
      { attack: "evil-median", step: "round 5 challenged", verdict: "REFUSED", where: "evm", evidence: { challengeTx: `0x${"a".repeat(64)}` } },
    ] };
    const rows = upheldRows([up("qor1public", "2F22"), up("qor1tower", "2E65")], [run1, evil]);
    expect(rows.every((x) => x.ours === undefined && x.who === undefined)).toBe(true);
  });
  it("copes with an old feed", () => expect(upheldRows(undefined, [counted])).toEqual([]));
});

describe("feed state", () => {
  const at = "2026-11-20T10:52:03.800Z";
  it("is live for a few minutes, then paused", () => {
    expect(feedState(at, Date.parse(at) + 60_000).paused).toBe(false);
    const s = feedState(at, Date.parse(at) + 2 * 3600_000 + 13 * 60_000);
    expect(s.paused).toBe(true);
    expect(formatAge(s.ageMs)).toBe("2 h 13 min");
  });
  it("does not call a bad timestamp paused", () => expect(feedState("nope").paused).toBe(false));
});

describe("dateline and tally", () => {
  it("dates the edition in UTC", () => expect(dateline("2026-11-20T10:52:03.800Z")).toEqual({ date: "Friday 20 November 2026", time: "10:52 UTC" }));
  it("survives a bad date", () => expect(dateline("nope")).toEqual({ date: "", time: "" }));
  it("counts check states", () => {
    const t = checkTally([{ state: "pass" }, { state: "pass" }, { state: "skip" }, { state: "run" }]);
    expect(t).toEqual({ passed: 2, failed: 0, skipped: 1, open: 1, text: "2 passed, 1 skipped" });
  });
});
