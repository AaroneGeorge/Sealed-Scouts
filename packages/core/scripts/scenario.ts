// Builds inbox entries for a round, the way scouts and the operator would post them. Used by fixtures and tests.
import {
  DEFAULT_RULES, DEFAULT_TIMING, commitment, encodeMsg, roundWindows,
  signCommit, type InboxEntry, type Opening, type PriceSet, type RoundParams, type RoundWindows,
} from "../src/index.js";
import { testBytes, testKey, type TestKey } from "./test-keys.js";

export const FIXTURE_ROUND = 5n;
export const FIXTURE_GENESIS = 1000n;

/** Params shared by every fixture. pqKeyOf is filled from the registered test keys. */
export function fixtureParams(registered: Map<string, Uint8Array>): RoundParams {
  return {
    genesisHeight: FIXTURE_GENESIS, ...DEFAULT_TIMING, ...DEFAULT_RULES,
    chainId: "qorechain-diana", rollupId: "sealed-scouts-1", operator: testKey("operator").qor,
    pqKeyOf: (s) => registered.get(s),
  };
}

export interface PostOpts {
  height?: bigint;
  /** Round number written in the message (defaults to the scenario round). */
  round?: bigint;
  /** Account that posts the entry (defaults to the scout itself). */
  poster?: TestKey;
}

export class Scenario {
  readonly entries: InboxEntry[] = [];
  readonly w: RoundWindows;
  private seq = 1n;

  constructor(readonly params: RoundParams, readonly round = FIXTURE_ROUND) {
    this.w = roundWindows(round, params);
  }

  post(poster: TestKey | string, height: bigint, payload: Uint8Array): this {
    this.entries.push({ seq: this.seq++, height, poster: typeof poster === "string" ? poster : poster.qor, payload });
    return this;
  }

  /** REPORT with an opaque stand-in for the QoreSeal envelope (core never opens it). */
  report(k: TestKey, o: PostOpts = {}): this {
    const round = o.round ?? this.round;
    const envelope = testBytes(`envelope/${k.label}/${round}`, 64);
    return this.post(o.poster ?? k, o.height ?? this.w.start + 10n, encodeMsg({ kind: "REPORT", round, envelope }));
  }

  /** COMMIT for `p`. `signer` signs instead of the scout; `signRound` puts another round in the signed text. */
  commit(k: TestKey, p: PriceSet, o: PostOpts & { salt?: Uint8Array; signer?: TestKey; signRound?: bigint } = {}): Opening {
    const round = o.round ?? this.round;
    const salt = o.salt ?? testBytes(`salt/${k.label}/${round}`, 16);
    const c = commitment(round, k.address, salt, p);
    const signer = o.signer ?? k;
    const sigCtx = { chainId: this.params.chainId, rollupId: this.params.rollupId, round: o.signRound ?? round, scout: k.qor, commitment: c };
    const signature = signCommit(signer.secretKey, sigCtx);
    this.post(o.poster ?? k, o.height ?? this.w.start + 11n, encodeMsg({ kind: "COMMIT", round, commitment: c, signature }));
    return { scout: k.address, salt, ...p };
  }

  /** REPORT then COMMIT from the same scout: the honest path. */
  scout(k: TestKey, p: PriceSet, o: PostOpts = {}): Opening {
    this.report(k, o);
    return this.commit(k, p, o);
  }

  open(openings: Opening[], o: { height?: bigint; poster?: TestKey; round?: bigint } = {}): this {
    const msg = encodeMsg({ kind: "OPEN", round: o.round ?? this.round, openings });
    return this.post(o.poster ?? testKey("operator"), o.height ?? this.w.commitEnd + 5n, msg);
  }

  reveal(k: TestKey, op: Opening, o: { height?: bigint; round?: bigint } = {}): this {
    const msg = encodeMsg({ kind: "REVEAL", round: o.round ?? this.round, salt: op.salt, feedIds: op.feedIds, prices: op.prices });
    return this.post(k, o.height ?? this.w.openEnd + 5n, msg);
  }
}

/** ETH, BTC, USD prices with 8 decimals, given in whole cents. */
export const px = (eth: number, btc: number, usd: number): PriceSet => ({
  feedIds: [1, 2, 3],
  prices: [BigInt(Math.round(eth * 100)) * 1_000_000n, BigInt(Math.round(btc * 100)) * 1_000_000n, BigInt(Math.round(usd * 10_000)) * 10_000n],
});
