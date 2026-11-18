// Demo switch for the evil-median attack (off by default). For ONE chosen round the operator lies about one
// median in the attestation it anchors and relays, while the leaves and reportsRoot stay real. The watchtower
// then proves the lie to PriceFeed.challengeMedian and the operator's bond is slashed.
// Set it with SS_EVIL_MEDIAN_ROUND (+ SS_EVIL_MEDIAN_FEED, SS_EVIL_MEDIAN_PRICE), or drop a file
// run/operator/evil-median.json {"round": N, "feedId": 1, "price": "100000000"}. The file is renamed after use.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { RoundAttestation } from "@sealed-scouts/core";

export interface EvilMedian {
  round: bigint;
  feedId: number;
  price: bigint;
  /** Where it came from, for the log and to retire a file after use. */
  source: string;
}

export function evilMedianFor(round: bigint, runDir: string, env: NodeJS.ProcessEnv = process.env): EvilMedian | undefined {
  const file = join(runDir, "evil-median.json");
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (BigInt(j.round) === round) return { round, feedId: Number(j.feedId ?? 1), price: BigInt(j.price ?? "100000000"), source: file };
  }
  if (env.SS_EVIL_MEDIAN_ROUND !== undefined && BigInt(env.SS_EVIL_MEDIAN_ROUND) === round) {
    return { round, feedId: Number(env.SS_EVIL_MEDIAN_FEED ?? "1"), price: BigInt(env.SS_EVIL_MEDIAN_PRICE ?? "100000000"), source: "env SS_EVIL_MEDIAN_ROUND" };
  }
  return undefined;
}

/** The attestation with one median replaced. Throws if the feed has no median this round (nothing to lie about). */
export function withEvilMedian(att: RoundAttestation, lie: EvilMedian): RoundAttestation {
  const i = att.feedIds.indexOf(lie.feedId);
  if (i < 0) throw new Error(`round ${att.round} has no median for feed ${lie.feedId}`);
  if (lie.price === 0n) throw new Error("a zero price is refused by PriceFeed itself; pick a wrong but non-zero price");
  const medians = [...att.medians];
  medians[i] = lie.price;
  return { ...att, medians };
}

/** A file switch fires once: rename it so a restart cannot repeat the lie. */
export function retireEvilMedian(lie: EvilMedian): void {
  if (lie.source.endsWith(".json")) renameSync(lie.source, lie.source.replace(/\.json$/, `.used-round-${lie.round}.json`));
}
