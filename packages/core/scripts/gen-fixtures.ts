// Writes repo/fixtures/scouts.json and repo/fixtures/rounds/*.json: one file per scenario round.
// Each scenario states its expected outcome by hand; generation fails if deriveRound disagrees.
// Run: npm run fixtures -w @sealed-scouts/core. Keys are TEST-ONLY (public seeds).
import { encodeQledgerDeposit, encodeQledgerTx, qledgerKeypairFromSeed, signQledgerTx } from "@qorechain/rdk";
import { MAGIC, concatBytes, decodeMsg, fromHex, jsonify, qorAddress, type Hex, type Opening, type RoundResult } from "../src/index.js";
import { checksOf, loadFixture, runFixture, type FixtureChecks } from "./fixture-io.js";
import { FIXTURE_ROUND, Scenario, fixtureParams, px } from "./scenario.js";
import { testKey, type TestKey } from "./test-keys.js";
import { writeJson } from "./write-json.js";

const NOTE = "TEST-ONLY fixture from packages/core/scripts/gen-fixtures.ts. Keys come from public seeds; never use them on chain.";
const [S1, S2, S3, S4, S5, S6, S7] = [1, 2, 3, 4, 5, 6, 7].map((i) => testKey(`scout${i}`)) as TestKey[];
const ROGUE = testKey("rogue");
const ATTACKER = testKey("attacker");
const OPERATOR = testKey("operator");
const ALL_KEYS = [S1, S2, S3, S4, S5, S6, S7, ROGUE, ATTACKER, OPERATOR];
const FIVE = [S1, S2, S3, S4, S5];

// Honest prices: medians are ETH 3120.00, BTC 97000.00, USD 0.9999.
const HONEST = new Map<TestKey, ReturnType<typeof px>>([
  [S1, px(3119.5, 96990, 0.9998)], [S2, px(3120, 97000, 0.9999)], [S3, px(3120.5, 97010, 1.0)],
  [S4, px(3121, 97020, 1.0001)], [S5, px(3118, 96980, 0.9997)], [S6, px(3120.25, 97005, 0.9999)], [S7, px(3119.75, 96995, 0.9999)],
]);
const HONEST_MEDIANS: [number, string, number][] = [[1, "312000000000", 5], [2, "9700000000000", 5], [3, "99990000", 5]];

interface Def {
  name: string;
  description: string;
  eligible?: TestKey[];
  registered?: TestKey[];
  build: (s: Scenario) => void;
  expect: { status?: RoundResult["status"]; leaves: TestKey[]; rejected?: [TestKey, string][]; outliers?: TestKey[]; inBand?: TestKey[]; skipped?: TestKey[]; medians?: [number, string, number][] };
}

/** Honest scouts post, and the operator opens all of them. Returns the openings by scout. */
function honest(s: Scenario, scouts: TestKey[], open = true): Map<TestKey, Opening> {
  const out = new Map(scouts.map((k) => [k, s.scout(k, HONEST.get(k)!)] as const));
  if (open) s.open([...out.values()]);
  return out;
}

const defs: Def[] = [
  {
    name: "01-honest",
    description: "Five honest scouts, all opened by the operator. Every report counts and is in band.",
    build: (s) => void honest(s, FIVE),
    expect: { leaves: FIVE, inBand: FIVE, medians: HONEST_MEDIANS },
  },
  {
    name: "02-outlier",
    description: "scout5 reports ETH 15% high (outlier, slashable); scout4 4% high (neither in band nor slashable).",
    build: (s) => {
      const o = [S1, S2, S3].map((k) => s.scout(k, HONEST.get(k)!));
      o.push(s.scout(S4, px(3250, 97020, 1.0001)), s.scout(S5, px(3600, 96980, 0.9997)));
      s.open(o);
    },
    expect: { leaves: FIVE, outliers: [S5], inBand: [S1, S2, S3], medians: [[1, "312050000000", 5], [2, "9700000000000", 5], [3, "99990000", 5]] },
  },
  {
    name: "03-missing-open-reveal",
    description: "The operator leaves scout3 out of OPEN. scout3 posts REVEAL in the grace window and still counts.",
    build: (s) => {
      const o = honest(s, FIVE, false);
      s.open([S1, S2, S4, S5].map((k) => o.get(k)!));
      s.reveal(S3, o.get(S3)!);
    },
    expect: { leaves: FIVE, inBand: FIVE, skipped: [S3], medians: HONEST_MEDIANS },
  },
  {
    name: "04-missing-open-no-reveal",
    description: "OPEN covers scouts 1, 2, 5. scout3 never reveals; scout4 reveals one block after reveal grace ends.",
    build: (s) => {
      const o = honest(s, FIVE, false);
      s.open([S1, S2, S5].map((k) => o.get(k)!));
      s.reveal(S4, o.get(S4)!, { height: s.w.revealEnd });
    },
    expect: { leaves: [S1, S2, S5], inBand: [S1, S2, S5], rejected: [[S3, "not-opened"], [S4, "reveal-outside-window"]] },
  },
  {
    name: "05-forged-poster",
    description:
      "attacker posts a REPORT for scout5's round while scout5 posts only COMMIT (same-poster rule). rogue (not eligible) replays scout1's COMMIT and posts a fake OPEN.",
    eligible: FIVE,
    build: (s) => {
      const o = honest(s, [S1, S2, S3, S4], false);
      s.report(S5, { poster: ATTACKER });
      o.set(S5, s.commit(S5, HONEST.get(S5)!));
      s.open([...o.values()]);
      const s1Commit = s.entries.find((e) => e.poster === S1.qor && decodeMsg(e.payload)?.kind === "COMMIT")!;
      s.report(ROGUE).post(ROGUE, s.w.start + 20n, s1Commit.payload);
      s.open([{ ...o.get(S1)!, prices: [1n, 1n, 1n] }], { poster: ROGUE });
    },
    expect: {
      leaves: [S1, S2, S3, S4], inBand: [S1, S2, S3, S4],
      rejected: [[ATTACKER, "missing-commit"], [ROGUE, "not-eligible"], [ROGUE, "open-not-operator"], [S5, "missing-report"]],
    },
  },
  {
    name: "06-late-report",
    description:
      "scout4's REPORT lands on the first block after the commit window; scout5's COMMIT lands one block before the round. scout2 and scout3 post on the first and last valid blocks.",
    build: (s) => {
      const o = [s.scout(S1, HONEST.get(S1)!), s.scout(S2, HONEST.get(S2)!, { height: s.w.start })];
      o.push(s.scout(S3, HONEST.get(S3)!, { height: s.w.commitEnd - 1n }));
      s.report(S4, { height: s.w.commitEnd });
      o.push(s.commit(S4, HONEST.get(S4)!));
      s.report(S5);
      o.push(s.commit(S5, HONEST.get(S5)!, { height: s.w.start - 1n }));
      s.open(o);
    },
    expect: { leaves: [S1, S2, S3], inBand: [S1, S2, S3], rejected: [[S4, "outside-commit-window"], [S5, "outside-commit-window"]] },
  },
  {
    name: "07-bad-signature",
    description:
      "scout4 signs with rogue's key; scout5 signs the text of another round; scout6 has no registered key; scout7 posts scout1's COMMIT bytes as its own.",
    eligible: [S1, S2, S3, S4, S5, S6, S7],
    registered: [S1, S2, S3, S4, S5, S7],
    build: (s) => {
      const o = honest(s, [S1, S2, S3, S6], false);
      s.report(S4);
      o.set(S4, s.commit(S4, HONEST.get(S4)!, { signer: ROGUE }));
      s.report(S5);
      o.set(S5, s.commit(S5, HONEST.get(S5)!, { signRound: FIXTURE_ROUND - 1n }));
      const s1Commit = s.entries.find((e) => e.poster === S1.qor && decodeMsg(e.payload)?.kind === "COMMIT")!;
      s.report(S7).post(S7, s.w.start + 20n, s1Commit.payload);
      s.open([...o.values()]);
    },
    expect: {
      leaves: [S1, S2, S3], inBand: [S1, S2, S3],
      rejected: [[S4, "bad-signature"], [S5, "bad-signature"], [S6, "no-pq-key"], [S7, "bad-signature"]],
    },
  },
  {
    name: "08-no-quorum",
    description: "Only two valid reports (scout3's signature is bad). No feed reaches quorum 3.",
    eligible: [S1, S2, S3],
    build: (s) => {
      const o = honest(s, [S1, S2], false);
      s.report(S3);
      o.set(S3, s.commit(S3, HONEST.get(S3)!, { signer: S1 }));
      s.open([...o.values()]);
    },
    expect: { status: "no-quorum", leaves: [S1, S2], rejected: [[S3, "bad-signature"]], medians: [] },
  },
  {
    name: "09-duplicate",
    description: "scout4 posts two REPORTs; scout5 posts two COMMITs with different prices. Both are rejected whole.",
    build: (s) => {
      const o = honest(s, [S1, S2, S3], false);
      s.report(S4).report(S4, { height: s.w.start + 30n });
      o.set(S4, s.commit(S4, HONEST.get(S4)!));
      s.report(S5);
      o.set(S5, s.commit(S5, HONEST.get(S5)!));
      s.commit(S5, px(3300, 96980, 0.9997), { height: s.w.start + 40n });
      s.open([...o.values()]);
    },
    expect: { leaves: [S1, S2, S3], inBand: [S1, S2, S3], rejected: [[S4, "duplicate-report"], [S5, "duplicate-commit"]] },
  },
  {
    name: "10-wrong-salt",
    description:
      "The operator opens scout4 with a wrong salt (scout4 does not reveal) and scout5 with a changed price (scout5 reveals and counts).",
    build: (s) => {
      const o = honest(s, FIVE, false);
      const bad4 = { ...o.get(S4)!, salt: new Uint8Array(16).fill(7) };
      const bad5 = { ...o.get(S5)!, prices: [999_900_000_000n, ...o.get(S5)!.prices.slice(1)] };
      s.open([o.get(S1)!, o.get(S2)!, o.get(S3)!, bad4, bad5]);
      s.reveal(S5, o.get(S5)!);
    },
    expect: { leaves: [S1, S2, S3, S5], inBand: [S1, S2, S3, S5], skipped: [S5], rejected: [[S4, "opening-mismatch"]] },
  },
  {
    name: "11-partial-feeds-bad-prices",
    description:
      "scout3 and scout4 report ETH and BTC only, so USD has 2 reports and no median. scout5 committed feeds out of order; scout6 committed a zero price.",
    eligible: [S1, S2, S3, S4, S5, S6],
    build: (s) => {
      const two = (k: TestKey) => ({ feedIds: [1, 2], prices: HONEST.get(k)!.prices.slice(0, 2) });
      const o = [s.scout(S1, HONEST.get(S1)!), s.scout(S2, HONEST.get(S2)!), s.scout(S3, two(S3)), s.scout(S4, two(S4))];
      o.push(s.scout(S5, { feedIds: [2, 1], prices: [9_700_000_000_000n, 312_000_000_000n] }));
      o.push(s.scout(S6, { feedIds: [1, 2, 3], prices: [312_000_000_000n, 0n, 99_990_000n] }));
      s.open(o);
    },
    expect: {
      leaves: [S1, S2, S3, S4], inBand: [S1, S2, S3, S4], rejected: [[S5, "bad-prices"], [S6, "bad-prices"]],
      medians: [[1, "312000000000", 4], [2, "9700000000000", 4]],
    },
  },
  {
    name: "12-noise-and-other-rounds",
    description:
      "Honest round mixed with ledger deposits and transfers, a JOIN, malformed SSC1 payloads, scout1's reports for rounds 4 and 6, and a late duplicate OPEN. Entries are stored out of order; seq decides.",
    build: (s) => {
      honest(s, FIVE);
      const a = qledgerKeypairFromSeed(new Uint8Array(32).fill(9));
      const b = qledgerKeypairFromSeed(new Uint8Array(32).fill(3));
      s.post(`deposit:${S1.qor}`, s.w.start + 1n, encodeQledgerDeposit(a.accountId, 5_000_000n));
      const tx = signQledgerTx({ chainId: "qorechain-diana", rollupId: "sealed-scouts-1", secretKey: a.secretKey, publicKey: a.publicKey, nonce: 0, amount: 1_000n, to: b.accountId });
      s.post(OPERATOR, s.w.start + 2n, encodeQledgerTx(tx));
      s.post(S2, s.w.start + 3n, concatBytes(MAGIC, new Uint8Array([0x01]), a.accountId));
      s.post(S3, s.w.start + 4n, concatBytes(MAGIC, new Uint8Array([0x03, 0, 0])));
      s.post(S3, s.w.start + 5n, concatBytes(MAGIC, new Uint8Array([0x09])));
      const prev = new Scenario(s.params, FIXTURE_ROUND - 1n);
      const next = new Scenario(s.params, FIXTURE_ROUND + 1n);
      for (const other of [prev, next]) {
        other.open([other.scout(S1, px(3000, 95000, 1))]);
        for (const e of other.entries) s.post(e.poster, e.height, e.payload);
      }
      s.open([], { height: s.w.openEnd });
      s.entries.reverse();
    },
    expect: { leaves: FIVE, inBand: FIVE, rejected: [[OPERATOR, "open-outside-window"]], medians: HONEST_MEDIANS },
  },
  {
    name: "13-no-open-all-reveal",
    description:
      "The operator posts no OPEN. scouts 1-3 reveal during the open window, scout4 on the last block of reveal grace; scout5 never reveals.",
    build: (s) => {
      const o = honest(s, FIVE, false);
      for (const k of [S1, S2, S3]) s.reveal(k, o.get(k)!, { height: s.w.commitEnd });
      s.reveal(S4, o.get(S4)!, { height: s.w.revealEnd - 1n });
    },
    expect: { leaves: [S1, S2, S3, S4], inBand: [S1, S2, S3, S4], skipped: [S1, S2, S3, S4], rejected: [[S5, "not-opened"]] },
  },
];

const qorOf = (addr: string) => qorAddress(addr as Hex);
const sortQ = (ks: TestKey[]) => ks.map((k) => k.qor);

export function buildFixtures(): Record<string, unknown> {
  const scouts = ALL_KEYS.map((k) => ({ label: k.label, qor: k.qor, address: k.address, seed: k.seed, publicKey: k.publicKey }));
  const files: Record<string, unknown> = { "scouts.json": { note: NOTE, scouts } };
  const scoutsJson = jsonify(scouts) as { qor: string; publicKey: string }[];
  for (const d of defs) {
    const eligible = d.eligible ?? FIVE;
    const registered = d.registered ?? eligible;
    const s = new Scenario(fixtureParams(new Map(registered.map((k) => [k.qor, k.publicKey]))));
    d.build(s);
    const { pqKeyOf: _, ...params } = s.params;
    const checks: FixtureChecks = {
      status: d.expect.status ?? "ok",
      leaves: sortQ(d.expect.leaves),
      rejected: (d.expect.rejected ?? []).map(([k, r]) => [k.qor, r]),
      outliers: sortQ(d.expect.outliers ?? []),
      inBand: sortQ(d.expect.inBand ?? []),
      skippedByOpener: sortQ(d.expect.skipped ?? []),
      ...(d.expect.medians ? { medians: d.expect.medians } : {}),
    };
    const fixture = jsonify({ note: NOTE, name: d.name, description: d.description, round: s.round, params, eligible: sortQ(eligible), registered: sortQ(registered), entries: s.entries }) as any;
    const result = runFixture(loadFixture(fixture, scoutsJson));
    assertChecks(d.name, result, checks);
    files[`rounds/${d.name}.json`] = { ...fixture, checks, expected: result };
  }
  return files;
}

/** Hand-written checks against a result. Lists of scouts compare as sets; order is fixed by deriveRound. */
export function assertChecks(name: string, r: RoundResult, c: FixtureChecks): void {
  const got = checksOf(r, qorOf);
  const set = (xs: unknown[]) => JSON.stringify(xs.map((x) => JSON.stringify(x)).sort());
  const fail = (what: string, a: unknown, b: unknown) => {
    throw new Error(`${name}: ${what} expected ${JSON.stringify(a)} got ${JSON.stringify(b)}`);
  };
  if (got.status !== c.status) fail("status", c.status, got.status);
  for (const k of ["leaves", "rejected", "outliers", "inBand", "skippedByOpener"] as const) if (set(got[k]) !== set(c[k])) fail(k, c[k], got[k]);
  if (c.medians) {
    const m = r.medians.map((x) => [x.feedId, x.price.toString(), x.count]);
    if (JSON.stringify(m) !== JSON.stringify(c.medians)) fail("medians", c.medians, m);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, v] of Object.entries(buildFixtures())) console.log("wrote", writeJson(rel, v));
}
