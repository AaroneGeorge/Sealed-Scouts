/**
 * JSON the page reads. The watchtower writes feed/status.json and feed/rounds/<n>.json (packages/watchtower,
 * feed.ts and tower.ts); the attack scripts write one evidence file per run (packages/attacks, evidence.ts); the
 * launch scripts write deployments/diana.json. Big integers travel as decimal strings, bytes as 0x hex.
 */
export type Hex = `0x${string}`;

export interface FeedMeta { feedId: number; symbol: string }
export interface Median { feedId: number; price: string; count: number }

/** PriceFeed's view of a round (Status enum: none, pending, final, corrected). */
export type FeedStatus = "none" | "pending" | "final" | "corrected";

export type RoundVerdict = "match" | "median-wrong" | "root-wrong" | "corrected" | "not-posted" | "no-quorum";

export interface TowerStatus {
  updatedAt: string;
  mode: "observe" | "active";
  rollupId: string;
  chainHeight: string;
  inboxHead: string;
  rounds: { replayed: number; match: number; corrected: number; medianWrong: number; rootWrong: number; notPosted: number; noQuorum: number; latest: string | null };
  batches: {
    replayed: number; ok: number; fraud: number; skipped: number; latestIndex: number | null;
    list: { batchIndex: number; verdict: "ok" | "fraud" | "skipped"; entries: number; note?: string; proofBytes: number }[];
  };
  operatorOmissions: number;
  challenges: Challenge[];
  latestRounds: { round: string; verdict: RoundVerdict; medians: Median[]; reports: number; leftOut: number; feedStatus: FeedStatus | null }[];
}

export interface Challenge { kind: "median" | "batch"; target: string; at: string; sent: boolean; txHash?: string; code?: number; error?: string }

export interface LeafJson { round: string; scout: Hex; salt: Hex; feedIds: number[]; prices: string[]; commitSigHash: Hex }

export interface AttestationJson {
  round: string; batchIndex: string; inboxStart: string; inboxEnd: string; closeHeight: string; closeTime: string;
  feedIds: number[]; medians: string[]; counts: number[]; reportsRoot: Hex; reportCount: number;
}

export interface TowerRound {
  round: string;
  verdict: RoundVerdict;
  status: "ok" | "no-quorum";
  openHeight: string;
  closeHeight: string;
  medians: Median[];
  reportsRoot: Hex;
  /** One tile per scout that posted: sizes and height always; prices only once opened. `scout` is a qor1 address. */
  reports: { scout: string; reportBytes: number; commitBytes: number; height: string; counted: boolean; prices?: { feedId: number; price: string }[] }[];
  leaves: LeafJson[];
  outliers: Hex[];
  inBand: Hex[];
  rejected: { scout: string; reason: string }[];
  operator: { openPosted: boolean; leftOut: { scout: string; how: "revealed" | "lost" }[] };
  feed: { status: FeedStatus; feedIds: number[]; medians: string[]; counts: number[]; reportsRoot: Hex; reportCount: number; batchIndex: string } | null;
  challenges: Challenge[];
  /** Round binding for the on-chain check. Optional until the watchtower writes them. */
  roundHash?: Hex;
  attestation?: AttestationJson;
  /** Two-signature mode (docs/SPEC.md, Changes 14), and the anchorSig argument as posted to PriceFeed. */
  twoSig?: boolean;
  anchorSig?: Hex;
}

export interface AttackStep {
  attack: string;
  step: string;
  /** REFUSED: the attack did not get through. ACCEPTED: an expected, harmless setup step. */
  verdict: "REFUSED" | "NOT REFUSED" | "ACCEPTED";
  where: "chain" | "rollup" | "evm" | "local check" | "simulation";
  evidence: Record<string, string | number | boolean>;
}

export interface AttackRun { name: string; note: string; at: string; steps: AttackStep[] }

export interface Deployments {
  chainId?: string;
  rollupId?: string;
  priceFeed?: Hex;
  scoutLend?: Hex;
  contracts?: { PriceFeed?: Hex; ScoutLend?: Hex };
}
