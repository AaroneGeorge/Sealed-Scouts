// What the scout, watchtower and attack scripts need from deployments/diana.json (written by the launch scripts).
// The file is read tolerantly: missing optional fields fall back to the spec defaults.
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_RULES, DEFAULT_TIMING, type RoundRules, type RoundTiming } from "@sealed-scouts/core";

export const DEFAULT_DEPLOYMENT_PATH = new URL("../../../deployments/diana.json", import.meta.url).pathname;

export interface Deployment {
  chainId: string;
  /** EVM chain id: part of the round hash domain. */
  evmChainId: number;
  rollupId: string;
  /** qor1 of the operator: rollup creator, sequencer and opener in v1. */
  operator: string;
  timing: RoundTiming;
  /** Shorter rounds for demos, when the deployment defines them. */
  demoTiming?: RoundTiming;
  rules: RoundRules;
  /** qor1 accounts eligible to report. */
  scouts: string[];
  priceFeed?: `0x${string}`;
  /** Which timing the operator runs ("roundMode", written when it starts). */
  roundMode?: "demo" | "normal";
}

type J = Record<string, any>;
const big = (v: unknown, fallback: bigint): bigint => (v === undefined || v === null ? fallback : BigInt(v as string));

function timingFrom(j: J | undefined, genesisHeight: bigint): RoundTiming {
  return {
    genesisHeight,
    roundBlocks: big(j?.roundBlocks, DEFAULT_TIMING.roundBlocks),
    commitBlocks: big(j?.commitBlocks, DEFAULT_TIMING.commitBlocks),
    openBlocks: big(j?.openBlocks, DEFAULT_TIMING.openBlocks),
    revealBlocks: big(j?.revealBlocks, DEFAULT_TIMING.revealBlocks),
  };
}

export function parseDeployment(j: J): Deployment {
  const rollupId = j.rollupId ?? j.rollup?.id;
  const operator = j.operator ?? j.creator ?? j.roles?.OPERATOR;
  const genesis = j.genesisHeight ?? j.rollup?.genesisHeight;
  if (!rollupId || !operator || genesis === undefined) throw new Error("deployment needs rollupId, operator and genesisHeight");
  const params: J = j.params ?? {};
  const demo: J | undefined = j.demo ?? params.demo;
  return {
    chainId: j.chainId ?? "qorechain-diana",
    evmChainId: Number(j.evmChainId ?? 9800),
    rollupId,
    operator,
    timing: timingFrom(params, BigInt(genesis)),
    demoTiming: demo ? timingFrom(demo, big(demo.genesisHeight, BigInt(genesis))) : undefined,
    rules: {
      quorum: Number(params.quorum ?? DEFAULT_RULES.quorum),
      bandBps: Number(params.bandBps ?? DEFAULT_RULES.bandBps),
      slashBps: Number(params.slashBps ?? DEFAULT_RULES.slashBps),
    },
    scouts: j.scouts ?? [],
    priceFeed: j.contracts?.PriceFeed ?? j.priceFeed,
    roundMode: j.roundMode === "demo" || j.roundMode === "normal" ? j.roundMode : undefined,
  };
}

/** Round timing for normal or demo rounds. Every replayer must pick the same one as the operator. */
export function timingOf(d: Deployment, demo: boolean): RoundTiming {
  return demo ? (d.demoTiming ?? d.timing) : d.timing;
}

/**
 * Demo rounds or normal ones: the --demo flag if given, else SS_DEMO if set ("1"/"true" or "0"/"false"), else the
 * operator's own choice in the deployment ("roundMode"), so a replayer follows the operator by default.
 */
export function useDemo(d: Deployment | undefined, flag?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag !== undefined) return flag;
  if (env.SS_DEMO !== undefined && env.SS_DEMO !== "") return env.SS_DEMO === "1" || env.SS_DEMO === "true";
  return d?.roundMode === "demo";
}

/** The deployment, or undefined before the rollup exists. */
export function loadDeployment(path = process.env.SS_DEPLOYMENT ?? DEFAULT_DEPLOYMENT_PATH): Deployment | undefined {
  return existsSync(path) ? parseDeployment(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}
