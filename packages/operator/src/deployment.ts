// deployments/diana.json: what every other package reads about the live rollup. Written by the launch
// script; the scout package parses the same shape (packages/scout/src/deployment.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function writeDeployment(d: DeploymentFile, path = DEPLOYMENT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
}

export function timingOf(d: DeploymentFile): RoundTiming {
  return {
    genesisHeight: BigInt(d.genesisHeight),
    roundBlocks: BigInt(d.params.roundBlocks),
    commitBlocks: BigInt(d.params.commitBlocks),
    openBlocks: BigInt(d.params.openBlocks),
    revealBlocks: BigInt(d.params.revealBlocks),
  };
}
