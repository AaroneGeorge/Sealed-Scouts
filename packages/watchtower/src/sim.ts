// An in-memory stand-in for the rollup, its inbox and PriceFeed: the same data shapes the live chain serves, made
// with the real codecs, sealing, signatures and qledger execution. Used by `--fixture`, the tests, and the
// attack scripts' --dry-run. Keys come from public test seeds: never use them on chain.
import { createHash } from "node:crypto";
import { sealKeysFromSeed } from "@qorechain/qoreseal";
import { pqKeyFromSeed } from "@qorechain/qoresign";
import {
  EMPTY_INBOX_ACC, QledgerLedger, bytesToHex, encodeQledgerDeposit, encodeQledgerTx, executeQledger, inboxRangeHash, qledgerAccumulate,
  qledgerKeypairFromSeed, signQledgerTx, type QledgerEntry,
} from "@qorechain/rdk";
import {
  DEFAULT_RULES, attestationFromJson, encodeMsg, entryFromJson, fromHex, jsonify, qorAddress, roundWindows, toHex, type InboxEntry, type Json, type RoundParams,
} from "@sealed-scouts/core";
import { buildReveal, buildSealedReport, type SealedReport } from "@sealed-scouts/scout";
import type { BatchInfo } from "./ledger.js";
import type { FeedRound } from "./rounds.js";
import type { TowerSource } from "./source.js";
import type { TowerConfig } from "./tower.js";

const seed = (label: string) => new Uint8Array(createHash("sha256").update(`sealed-scouts/test-seed/${label}`).digest());

export interface SimIdentity { label: string; address: string; keys: { pqc: { publicKey: Uint8Array; secretKey: Uint8Array } } }

export function simIdentity(label: string): SimIdentity {
  const pq = pqKeyFromSeed(seed(`${label}/mldsa87`));
  return { label, address: qorAddress(seed(`${label}/address`).slice(0, 20)), keys: { pqc: { publicKey: pq.publicKey, secretKey: pq.secretKey } } };
}

/** Tower settings for a simulation: no eligibility list, testnet EVM chain id. */
export const simTowerConfig = (params: TowerConfig["params"]): TowerConfig => ({ params, scouts: [], evmChainId: 9800n });

export const SIM_TIMING = { genesisHeight: 1000n, roundBlocks: 300n, commitBlocks: 180n, openBlocks: 40n, revealBlocks: 40n };

export class SimRollup {
  height: bigint;
  readonly entries: InboxEntry[] = [];
  readonly batches: BatchInfo[] = [];
  readonly feedRounds = new Map<bigint, FeedRound>();
  readonly pqKeys = new Map<string, Uint8Array>();
  /** Ledger after the last batch that stands, and the inbox position it covers. */
  private ledger = new QledgerLedger();
  private consumed = 0n;
  readonly operator = simIdentity("operator");
  readonly opener = sealKeysFromSeed(seed("operator/mlkem"));
  readonly operatorLedger = qledgerKeypairFromSeed(seed("operator/qledger"));
  readonly scouts: SimIdentity[];

  constructor(readonly params: Omit<RoundParams, "pqKeyOf"> = { ...SIM_TIMING, ...DEFAULT_RULES, chainId: "qorechain-diana", rollupId: "sealed-scouts-sim", operator: simIdentity("operator").address }, scoutCount = 5) {
    this.height = params.genesisHeight;
    this.scouts = Array.from({ length: scoutCount }, (_, i) => simIdentity(`scout${i + 1}`));
    for (const s of this.scouts) this.pqKeys.set(s.address, s.keys.pqc.publicKey);
  }

  get env() {
    return { chainId: this.params.chainId, rollupId: this.params.rollupId };
  }

  post(poster: string, payloads: Uint8Array[]): bigint[] {
    return payloads.map((payload) => {
      const seq = BigInt(this.entries.length + 1);
      this.entries.push({ seq, height: this.height, poster, payload });
      return seq;
    });
  }

  deposit(account: Uint8Array, amount: bigint): void {
    this.post(`deposit:${this.operator.address}`, [encodeQledgerDeposit(account, amount)]);
  }

  /** Every scout reports `prices(i)` in the round's commit window. Returns the sealed reports. */
  reportRound(round: bigint, prices: (i: number) => { feedIds: number[]; prices: bigint[] }): SealedReport[] {
    this.height = roundWindows(round, this.params).start + 5n;
    return this.scouts.map((s, i) => {
      const r = buildSealedReport({ ...this.env, round, scout: s, openerKemKey: this.opener.mlkemPublicKey, prices: prices(i) });
      this.post(s.address, [r.report, r.commit]);
      return r;
    });
  }

  /** The operator's OPEN for `round`, leaving out the scouts in `skip`. */
  open(round: bigint, reports: SealedReport[], skip: number[] = []): void {
    this.height = roundWindows(round, this.params).commitEnd + 2n;
    const openings = reports.filter((_, i) => !skip.includes(i)).map((r) => ({ scout: r.scout20, salt: r.salt, ...r.prices }));
    this.post(this.operator.address, [encodeMsg({ kind: "OPEN", round, openings })]);
  }

  reveal(round: bigint, scout: number, report: SealedReport): void {
    this.height = roundWindows(round, this.params).openEnd + 2n;
    this.post(this.scouts[scout]!.address, [buildReveal(report)]);
  }

  /** A ledger transfer from the operator's reward account. */
  pay(to: Uint8Array, amount: bigint): void {
    const nonce = this.ledgerNow().get(this.operatorLedger.accountId).nonce;
    const tx = signQledgerTx({ ...this.env, secretKey: this.operatorLedger.secretKey, publicKey: this.operatorLedger.publicKey, nonce, amount, to });
    this.post(this.operator.address, [encodeQledgerTx(tx)]);
  }

  /** The ledger as it stands after every entry posted so far (what the next transaction's nonce depends on). */
  private ledgerNow(): QledgerLedger {
    const l = new QledgerLedger();
    executeQledger(this.env, l, this.entries.map(toQ));
    return l;
  }

  /** Submit a batch over every unconsumed post. `tamper` swaps in a wrong state root, as a dishonest submitter would. */
  submitBatch(opts: { tamper?: boolean } = {}): BatchInfo {
    const end = BigInt(this.entries.length);
    const consumed = this.entries.filter((e) => e.seq > this.consumed && e.seq <= end).map(toQ);
    const after = this.ledger.clone();
    const prevStateRoot = bytesToHex(this.ledger.root());
    const result = executeQledger(this.env, after, consumed);
    const accFrom = this.accAt(this.consumed);
    const stateRoot = opts.tamper ? toHex(seed(`tampered/${this.batches.length}`)).slice(2) : bytesToHex(result.stateRoot);
    const batch: BatchInfo = {
      batchIndex: this.batches.length,
      inboxStart: Number(this.consumed),
      inboxEnd: Number(end),
      dataHash: bytesToHex(inboxRangeHash({ ...this.env, from: this.consumed, to: end, accFrom, accTo: this.accAt(end) })),
      prevStateRoot,
      stateRoot,
      withdrawalsRoot: bytesToHex(result.withdrawalsRoot),
      status: "submitted",
    };
    this.batches.push(batch);
    if (!opts.tamper) {
      this.ledger = after;
      this.consumed = end;
    }
    return batch;
  }

  private accAt(seq: bigint): Uint8Array {
    return qledgerAccumulate({ ...this.env, from: 0, accFrom: EMPTY_INBOX_ACC, entries: this.entries.filter((e) => e.seq <= seq).map(toQ) });
  }

  asSource(): TowerSource {
    return {
      height: async () => this.height,
      inboxHead: async () => BigInt(this.entries.length),
      readInbox: async (from, to) => this.entries.filter((e) => e.seq >= from && e.seq <= to),
      batches: async (from) => this.batches.filter((b) => b.batchIndex >= from).map((b) => ({ ...b })),
      pqKey: async (s) => this.pqKeys.get(s),
      feedRound: async (r) => this.feedRounds.get(r) ?? { status: "none", feedIds: [], medians: [], counts: [], reportsRoot: `0x${"00".repeat(32)}`, reportCount: 0, batchIndex: 0n },
    };
  }

  toJSON(): Json {
    return jsonify({
      note: "TEST-ONLY simulated rollup from packages/watchtower/src/sim.ts. Keys come from public test seeds.",
      params: this.params,
      height: this.height,
      pqKeys: Object.fromEntries(this.pqKeys),
      entries: this.entries,
      batches: this.batches,
      feedRounds: Object.fromEntries(this.feedRounds),
    });
  }
}

const toQ = (e: InboxEntry): QledgerEntry => ({ height: e.height, poster: e.poster, payload: e.payload });

/** A recorded simulation (from SimRollup.toJSON) as a read-only source. */
export function sourceFromJson(j: Record<string, any>): { params: Omit<RoundParams, "pqKeyOf">; source: TowerSource } {
  const p = j.params;
  const params = {
    ...p,
    genesisHeight: BigInt(p.genesisHeight), roundBlocks: BigInt(p.roundBlocks), commitBlocks: BigInt(p.commitBlocks),
    openBlocks: BigInt(p.openBlocks), revealBlocks: BigInt(p.revealBlocks),
  };
  const entries: InboxEntry[] = j.entries.map(entryFromJson);
  const feed = new Map<string, FeedRound>(
    Object.entries(j.feedRounds as Record<string, any>).map(([r, f]) => [r, { ...f, medians: f.medians.map(BigInt), batchIndex: BigInt(f.batchIndex), attestation: f.attestation && attestationFromJson(f.attestation) }]),
  );
  return {
    params,
    source: {
      height: async () => BigInt(j.height),
      inboxHead: async () => BigInt(entries.length),
      readInbox: async (from, to) => entries.filter((e) => e.seq >= from && e.seq <= to),
      batches: async (from) => (j.batches as BatchInfo[]).filter((b) => b.batchIndex >= from),
      pqKey: async (s) => (j.pqKeys[s] ? fromHex(j.pqKeys[s]) : undefined),
      feedRound: async (r) => feed.get(r.toString()),
    },
  };
}
