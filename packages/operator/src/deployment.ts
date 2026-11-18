// deployments/diana.json: what every other package reads about the live rollup. Track C's launch script owns
// every key except `contracts`, which Track B's deploy script fills in. Both merge into the file and keep the
// other's keys. The scout package parses the same shape (packages/scout/src/deployment.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_RULES, DEFAULT_TIMING, type RoundTiming } from "@sealed-scouts/core";

export const DEPLOYMENT_PATH =
  process.env.SS_DEPLOYMENT ?? new URL("../../../deployments/diana.json", import.meta.url).pathname;

export interface DeploymentFile {
  chainId: string;
  evmChainId: number;
  rollupId: string;
  /** qor1 of the operator: rollup creator, sequencer and opener in v1. */
  operator: string;
  operatorEvm: `0x${string}`;
  /** First block of round 0. */
  genesisHeight: string;
  createdHeight: string;
  params: {
    roundBlocks: string;
    commitBlocks: string;
    openBlocks: string;
    revealBlocks: string;
    quorum: number;
    bandBps: number;
    slashBps: number;
    /** Rewards are paid once every this many rounds. */
    rewardEpochRounds: number;
    /** Ledger uqor per in-band report. */
    rewardPerReportUqor: string;
  };
  /**
   * Shorter rounds for live demos (`loop --demo`, `scout --demo`). Its own genesisHeight defaults to the main one.
   * PriceFeed only accepts increasing round numbers, so switch a running deployment between the two timings
   * only with a genesisHeight that keeps round numbers growing.
   */
  demo?: { roundBlocks: string; commitBlocks: string; openBlocks: string; revealBlocks: string; genesisHeight?: string };
  /** The timing the running operator uses; written by the loop at start. Scouts and the web default to it. */
  roundMode?: RoundMode;
  /** qor1 accounts eligible to report. */
  scouts: string[];
  contracts: { PriceFeed?: `0x${string}`; ScoutLend?: `0x${string}` };
  /** Launch transactions, by step. */
  txs: Record<string, string>;
}

export function defaultParams(): DeploymentFile["params"] {
  return {
    roundBlocks: String(DEFAULT_TIMING.roundBlocks),
    commitBlocks: String(DEFAULT_TIMING.commitBlocks),
    openBlocks: String(DEFAULT_TIMING.openBlocks),
    revealBlocks: String(DEFAULT_TIMING.revealBlocks),
    ...DEFAULT_RULES,
    rewardEpochRounds: 6,
    rewardPerReportUqor: "100000",
  };
}

export function readDeployment(path = DEPLOYMENT_PATH): DeploymentFile | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DeploymentFile) : undefined;
}

/** Keys Track C writes. Everything else in the file (Track B's `contracts`, anything added later) is kept. */
export type OwnKeys = Omit<DeploymentFile, "contracts">;

/** Read-modify-write: replace only Track C's keys, keep the rest of the file as it is. */
export function mergeDeployment(mine: OwnKeys, path = DEPLOYMENT_PATH): DeploymentFile {
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const merged = { ...current, ...mine, contracts: (current.contracts as DeploymentFile["contracts"]) ?? {} };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(merged, null, 2) + "\n");
  renameSync(path + ".tmp", path);
  return merged;
}

export type RoundMode = "demo" | "normal";

/** Write only `roundMode`; every other key stays as it is. */
export function setRoundMode(mode: RoundMode, path = DEPLOYMENT_PATH): void {
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path + ".tmp", JSON.stringify({ ...current, roundMode: mode }, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}

/** Write only `contracts` (for a deploy done from TypeScript); every other key stays as it is. */
export function mergeContracts(contracts: DeploymentFile["contracts"], path = DEPLOYMENT_PATH): void {
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(path + ".tmp", JSON.stringify({ ...current, contracts: { ...(current.contracts ?? {}), ...contracts } }, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}

export function defaultDemo(): NonNullable<DeploymentFile["demo"]> {
  return { roundBlocks: "90", commitBlocks: "45", openBlocks: "15", revealBlocks: "15" };
}

/** Round timing of the deployment, or of its demo block when `demo` is set (falling back to the main timing). */
export function timingOf(d: DeploymentFile, demo = false): RoundTiming {
  const t = demo && d.demo ? d.demo : d.params;
  return {
    genesisHeight: BigInt((demo && d.demo?.genesisHeight) || d.genesisHeight),
    roundBlocks: BigInt(t.roundBlocks),
    commitBlocks: BigInt(t.commitBlocks),
    openBlocks: BigInt(t.openBlocks),
    revealBlocks: BigInt(t.revealBlocks),
  };
}
