// Fixture file format, shared by the generator and the tests.
import { deriveRound, entryFromJson, fromHex, type InboxEntry, type RoundParams, type RoundResult } from "../src/index.js";

export interface FixtureChecks {
  status: RoundResult["status"];
  leaves: string[];
  rejected: [string, string][];
  outliers: string[];
  inBand: string[];
  skippedByOpener: string[];
  /** [feedId, price, count], written by hand where the fixture is about the median. */
  medians?: [number, string, number][];
}

export interface Loaded { round: bigint; entries: InboxEntry[]; params: RoundParams; eligible: (s: string, r: bigint) => boolean }

/** Turn a parsed fixture plus the parsed scouts.json into deriveRound inputs. */
export function loadFixture(f: any, scouts: { qor: string; publicKey: string }[]): Loaded {
  const keys = new Map(scouts.filter((s) => f.registered.includes(s.qor)).map((s) => [s.qor, fromHex(s.publicKey)]));
  const p = f.params;
  const params: RoundParams = {
    genesisHeight: BigInt(p.genesisHeight), roundBlocks: BigInt(p.roundBlocks), commitBlocks: BigInt(p.commitBlocks),
    openBlocks: BigInt(p.openBlocks), revealBlocks: BigInt(p.revealBlocks), quorum: p.quorum, bandBps: p.bandBps, slashBps: p.slashBps,
    chainId: p.chainId, rollupId: p.rollupId, operator: p.operator, pqKeyOf: (s) => keys.get(s),
  };
  const eligible = new Set<string>(f.eligible);
  return { round: BigInt(f.round), entries: f.entries.map(entryFromJson), params, eligible: (s) => eligible.has(s) };
}

export const runFixture = (l: Loaded): RoundResult => deriveRound(l.entries, l.round, l.params, l.eligible);

/** The facts a fixture checks by hand, read off a result. */
export function checksOf(r: RoundResult, qorOf: (addr: string) => string): FixtureChecks {
  return {
    status: r.status,
    leaves: r.leaves.map((l) => qorOf(l.scout)),
    rejected: r.rejected.map((x) => [x.scout, x.reason]),
    outliers: r.outliers.map((l) => qorOf(l.scout)),
    inBand: r.inBand.map((l) => qorOf(l.scout)),
    skippedByOpener: r.skippedByOpener,
  };
}
