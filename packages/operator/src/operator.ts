// The operator loop. One call to tick() does whatever the chain height allows, in order:
//   1. open:   after a round's commit window, post OPEN (the decrypted reports) inside the open window;
//   2. settle: after the reveal window, derive the round, submit the next ledger batch with the round
//              hash as the anchor's validator_set_hash, and relay the round to PriceFeed;
//   3. reward: at the end of each epoch, pay in-band scouts with ledger transfers;
//   4. exit:   execute ledger withdrawals of finalized batches.
// The round clock is the main-chain height (packages/core round.ts), never the local clock.
import {
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  QledgerLedger,
  RestClient,
  encodeQledgerTx,
  executeQledger,
  executeWithdrawalMsg,
  planQledgerBatch,
  qledgerWithdrawalProof,
  signQledgerTx,
  submitBatchMsg,
  bytesToHex,
} from "@qorechain/rdk";
import { fetchPqcStatus, pqcStatusPublicKey } from "@qorechain/sdk";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { ScoutEligibility, getJson, type Account, type Chain, type InboxEntry } from "@sealed-scouts/chain";
import {
  deriveRound,
  fromHex,
  roundHash,
  roundOf,
  roundWindows,
  toAttestation,
  toHex,
  type RoundParams,
  type RoundResult,
} from "@sealed-scouts/core";
import { ledgerKeyOf, type LedgerKey } from "@sealed-scouts/scout";
import { anchorSignature } from "./anchor.js";
import { attestationFromRecord, feedProgress, feedTwoSigMode, roundSignature } from "./contracts.js";
import { evilMedianFor, retireEvilMedian, withEvilMedian, type EvilMedian } from "./evil.js";
import { timingOf, type DeploymentFile } from "./deployment.js";
import { replayLedger, type SettledBatch } from "./ledger.js";
import { buildOpenings, openPayload } from "./opener.js";
import { Relayer } from "./relay.js";
import { addInBand, joinsFrom, rewardLines } from "./rewards.js";
import { RUN_DIR, type OperatorState, type StateStore } from "./state.js";

/** A round whose relay keeps failing is given up after this many tries (the round record keeps the error). */
/** More missed rounds than this after a stop are skipped rather than settled one by one. */
const MAX_CATCH_UP_ROUNDS = 3n;
const MAX_RELAY_ATTEMPTS = 3;

/** Do not post an OPEN this close to the end of the open window: it might land too late. */
const OPEN_SAFETY_BLOCKS = 3n;

export interface OperatorDeps {
  chain: Chain;
  deployment: DeploymentFile;
  operator: Account;
  /** Opener's QoreSeal keys (the ML-KEM key registered on chain). */
  sealKeys: SealKeyPair;
  /** Account that relays rounds to PriceFeed; none = no relay. */
  relayer?: Account;
  store: StateStore;
  /** Use the deployment's demo timing. */
  demo?: boolean;
  log?: (line: string) => void;
}

export class Operator {
  private readonly rest: RestClient;
  private readonly params: RoundParams;
  private readonly ledgerKey: LedgerKey;
  private readonly relay?: Relayer;
  private readonly eligibility: ScoutEligibility;
  /** PriceFeed's mode: anchors with an empty validator_set_hash plus a separate round signature (SPEC Changes 14). */
  private twoSig = process.env.SS_TWO_SIG === "true";
  private readonly pqKeys = new Map<string, Uint8Array>();
  private readonly joins = new Map<string, Uint8Array>();
  private ledger = new QledgerLedger();
  private batches: SettledBatch[] = [];
  /** Recent inbox entries (the window the unsettled rounds need), in sequence order. */
  private entries: InboxEntry[] = [];
  private state: OperatorState;
  private readonly log: (line: string) => void;

  constructor(private readonly d: OperatorDeps) {
    const { deployment: dep, chain } = d;
    this.rest = new RestClient(chain.config.rest, { fetch: chain.fetch });
    this.params = {
      ...timingOf(dep, d.demo),
      quorum: dep.params.quorum,
      bandBps: dep.params.bandBps,
      slashBps: dep.params.slashBps,
      chainId: dep.chainId,
      rollupId: dep.rollupId,
      operator: dep.operator,
      pqKeyOf: (scout) => this.pqKeys.get(scout),
    };
    this.ledgerKey = ledgerKeyOf(d.operator.keys.pqc.secretKey);
    if (d.relayer && dep.contracts.PriceFeed) this.relay = new Relayer(chain, d.relayer, dep.contracts.PriceFeed);
    this.eligibility = new ScoutEligibility(chain.evm.publicClient, dep.scouts, dep.contracts.PriceFeed);
    this.state = d.store.load();
    this.log = d.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  }

  private get env() {
    return { chainId: this.d.deployment.chainId, rollupId: this.d.deployment.rollupId };
  }

  /** Rebuild the ledger and the JOIN map from the chain. Call once before the first tick. */
  async start(): Promise<void> {
    // The deployed feed decides the signature mode; without one the env var does.
    if (this.d.deployment.contracts.PriceFeed) this.twoSig = await feedTwoSigMode(this.d.chain, this.d.deployment.contracts.PriceFeed);
    this.log(`signature mode: ${this.twoSig ? "two signatures (anchor with empty vsh + round signature)" : "round hash in the anchor's validator_set_hash"}`);
    const r = await replayLedger(this.env, this.rest, this.d.chain.inbox);
    this.ledger = r.ledger;
    this.batches = r.batches;
    joinsFrom(r.entries, this.joins);
    this.entries = r.entries;
    await this.refreshEntries();
    this.log(`started: ${r.batches.length} batches replayed, ledger root ${bytesToHex(this.ledger.root()).slice(0, 16)}…, inbox at ${this.lastSeq()}`);
  }

  async tick(): Promise<void> {
    const height = BigInt(await this.rest.getLatestHeight());
    if (height < this.params.genesisHeight) return;
    await this.refreshEntries();
    await this.openRounds(height);
    await this.settleRounds(height);
    await this.relayPending();
    await this.payRewards();
    await this.executeWithdrawals();
    this.pruneEntries(height);
  }

  // ---- 1. open ----

  private async openRounds(height: bigint): Promise<void> {
    const current = roundOf(height, this.params);
    // Back from a stop: rounds that passed while nothing ran have no openings to post. Settling each one would
    // sweep the scouts' fresh reports into stale batches and leave the current rounds empty, so first settle what
    // was already opened, then jump to the current round.
    if (this.state.lastOpened !== undefined && current - BigInt(this.state.lastOpened) > MAX_CATCH_UP_ROUNDS) {
      if (this.state.lastSettled !== this.state.lastOpened) return; // settleRounds finishes the opened ones first
      const from = BigInt(this.state.lastOpened) + 1n;
      this.log(`rounds ${from} to ${current - 1n}: passed while the operator was stopped; skipped, not settled`);
      this.state.lastOpened = this.state.lastSettled = String(current - 1n);
      this.d.store.save(this.state);
    }
    let round = this.state.lastOpened !== undefined ? BigInt(this.state.lastOpened) + 1n : current;
    for (; round <= current; round++) {
      const w = roundWindows(round, this.params);
      if (height < w.commitEnd) break;
      if (height >= w.openEnd - OPEN_SAFETY_BLOCKS) {
        this.log(`round ${round}: open window missed (height ${height}); scouts may REVEAL themselves`);
      } else {
        const { openings, unopened } = buildOpenings(this.entries, round, { ...this.env, timing: this.params, keys: this.d.sealKeys });
        const tx = await this.d.chain.native.postToInbox(this.d.operator, [openPayload(round, openings)], this.env.rollupId);
        this.log(`round ${round}: OPEN with ${openings.length} openings at seq ${tx.sequences[0]} (tx ${tx.txHash})${unopened.length ? `, unopened: ${JSON.stringify(unopened)}` : ""}`);
      }
      this.state.lastOpened = String(round);
      if (this.state.lastSettled === undefined) this.state.lastSettled = String(round - 1n);
      this.d.store.save(this.state);
    }
  }

  // ---- 2. settle ----
  // Each stage persists its result before the next one starts, so a failure anywhere (and a restart) resumes
  // without a second batch, a lost tally or a relay that overwrites a good record:
  //   settle: batch sent -> lastSettled, tally, rewardDue, pendingRelays and the round record saved together;
  //   relay:  one round at a time, ascending, skipped if PriceFeed already holds it or a later round;
  //   reward: the tally is cleared only once the transfers are on the ledger.

  private async settleRounds(height: bigint): Promise<void> {
    if (this.state.lastOpened === undefined || this.state.lastSettled === undefined) return;
    for (let round = BigInt(this.state.lastSettled) + 1n; round <= BigInt(this.state.lastOpened); round++) {
      if (height < roundWindows(round, this.params).revealEnd) break;
      await this.refreshEntries();
      await this.settle(round);
    }
  }

  private async settle(round: bigint): Promise<void> {
    const dep = this.d.deployment;
    await this.loadPqKeys(round);
    // Eligibility is read at the round's close height, the same snapshot every watchtower takes.
    const snap = await this.eligibility.snapshot(round, roundWindows(round, this.params).commitEnd);
    if (snap.status === "unknown") throw new Error(`round ${round}: eligibility unknown (${snap.reason}); retrying next tick`);
    const result = deriveRound(this.entries, round, this.params, this.eligibility.eligible);
    this.eligibility.forget(round);

    let plan;
    try {
      plan = await planQledgerBatch(this.rest, { ...this.env, submitter: this.d.operator.address, ledger: this.ledger });
    } catch (err) {
      const reason = (err as Error).message;
      // Only an empty inbox ends the round unanchored; any other failure is retried on the next tick.
      if (!/nothing to settle/.test(reason)) throw err;
      this.log(`round ${round}: nothing to settle; recorded, not anchored`);
      this.state.lastSettled = String(round);
      this.d.store.saveRound(round, { round, result: summary(result), anchored: false, reason });
      this.d.store.save(this.state);
      return;
    }
    const inboxEnd = plan.input.inboxEnd;
    const honest = toAttestation(result, {
      index: plan.input.batchIndex,
      inboxStart: inboxEnd - BigInt(plan.entries.length),
      inboxEnd,
      closeTime: await this.blockTime(result.closeHeight),
    });
    const lie = this.evilMedian(round, result);
    const att = lie ? withEvilMedian(honest, lie) : honest;
    const rh = roundHash(att, { chainId: BigInt(dep.evmChainId), rollupId: dep.rollupId });
    const vsh = this.twoSig ? new Uint8Array() : fromHex(rh);
    const sig = anchorSignature(this.d.operator, {
      chainId: dep.chainId,
      layerId: dep.rollupId,
      batchIndex: plan.input.batchIndex,
      stateRoot: plan.input.stateRoot,
      txCount: plan.input.txCount,
      validatorSetHash: vsh,
    });
    // PriceFeed takes the anchor signature, or in two-signature mode anchorSig ‖ roundSig.
    const feedSig = this.twoSig ? concat(sig, roundSignature(this.d.operator, dep.chainId, dep.rollupId, round, rh)) : sig;
    const tx = await this.d.chain.native.sendOrThrow(this.d.operator, [
      submitBatchMsg({ sequencer: this.d.operator.address, ...plan.input, ...(this.twoSig ? {} : { validatorSetHash: vsh }), anchorSignature: sig }),
    ]);

    // The batch is on chain: record everything that follows from it in one save.
    this.ledger = plan.ledger;
    if (lie) retireEvilMedian(lie);
    this.batches.push({ batchIndex: Number(plan.input.batchIndex), status: "submitted", inboxStart: att.inboxStart, inboxEnd, withdrawals: plan.result.withdrawals });
    const relayed = !this.relay
      ? { status: "skipped", reason: "no PriceFeed or relayer configured" }
      : result.status !== "ok"
        ? { status: "skipped", reason: "no quorum" }
        : { status: "pending", attempts: 0 };
    this.d.store.saveRound(round, {
      round,
      result: summary(result),
      attestation: att,
      roundHash: rh,
      batch: { index: plan.input.batchIndex, stateRoot: toHex(plan.input.stateRoot), txCount: plan.input.txCount, submitTx: tx.txHash },
      anchorSignature: toHex(sig),
      feedSignature: toHex(feedSig),
      twoSig: this.twoSig,
      relayed,
      ...(lie ? { evilMedian: { feedId: lie.feedId, posted: lie.price, honest: honest.medians[honest.feedIds.indexOf(lie.feedId)] } } : {}),
    });
    addInBand(this.state.tally, result);
    if ((round + 1n) % BigInt(dep.params.rewardEpochRounds) === 0n) this.state.rewardDue = String(round);
    if (relayed.status === "pending") this.state.pendingRelays.push(String(round));
    this.state.lastSettled = String(round);
    this.d.store.save(this.state);
    this.log(`round ${round}: ${result.status}, ${result.leaves.length} reports, batch ${plan.input.batchIndex} (${plan.entries.length} entries) anchored with round hash ${rh.slice(0, 12)}… tx ${tx.txHash}`);
  }

  /** The demo lie for this round, if one is set and the feed has a median to replace. Logged loudly. */
  private evilMedian(round: bigint, result: RoundResult): EvilMedian | undefined {
    const lie = evilMedianFor(round, RUN_DIR);
    if (!lie) return undefined;
    if (!result.medians.some((m) => m.feedId === lie.feedId)) {
      this.log(`!!! EVIL MEDIAN requested for round ${round} feed ${lie.feedId} (${lie.source}) but the feed has no median; posting the honest round`);
      return undefined;
    }
    this.log(`!!! EVIL MEDIAN DEMO: round ${round} feed ${lie.feedId} will be posted as ${lie.price} instead of the derived median (${lie.source})`);
    return lie;
  }

  // ---- relay ----

  private async relayPending(): Promise<void> {
    const feed = this.d.deployment.contracts.PriceFeed;
    if (!this.relay || !feed) return;
    for (const r of [...this.state.pendingRelays]) {
      const round = BigInt(r);
      const rec = this.d.store.loadRound(round);
      const progress = await feedProgress(this.d.chain, feed, round);
      if (progress.posted) rec.relayed = { ...rec.relayed, status: "posted", note: "PriceFeed already holds this round" };
      else if (progress.superseded) rec.relayed = { status: "skipped", reason: "a later round is already on PriceFeed" };
      else {
        try {
          const p = await this.relay.postRound(attestationFromRecord(rec.attestation), rec.batch.stateRoot, BigInt(rec.batch.txCount), rec.feedSignature);
          rec.relayed = { status: "posted", hash: p.hash, gasUsed: p.gasUsed.toString() };
          this.log(`round ${round}: relayed to PriceFeed (tx ${p.hash}, gas ${p.gasUsed})`);
        } catch (err) {
          const attempts = Number(rec.relayed?.attempts ?? 0) + 1;
          const error = (err as Error).message.split("\n")[0];
          rec.relayed = { status: attempts >= MAX_RELAY_ATTEMPTS ? "failed" : "pending", attempts, error };
          this.log(`round ${round}: relay FAILED, attempt ${attempts} of ${MAX_RELAY_ATTEMPTS} (${error})`);
          this.d.store.saveRound(round, rec);
          // Rounds must reach PriceFeed in order: stop here until this one is posted or given up.
          if (rec.relayed.status === "pending") return;
        }
      }
      this.state.pendingRelays = this.state.pendingRelays.filter((x) => x !== r);
      this.d.store.saveRound(round, rec);
      this.d.store.save(this.state);
    }
  }

  // ---- 3. reward ----

  private async payRewards(): Promise<void> {
    if (this.state.rewardDue === undefined) return;
    const round = this.state.rewardDue;
    const me = this.headLedger().get(this.ledgerKey.accountId);
    const done = () => {
      this.state.tally = {};
      this.state.rewardDue = undefined;
      this.state.rewardPosting = undefined;
      this.d.store.save(this.state);
    };
    // A post from an earlier attempt that did land has moved the operator's ledger nonce on.
    if (this.state.rewardPosting && me.nonce > BigInt(this.state.rewardPosting.nonce)) {
      this.log(`epoch ending round ${round}: the earlier reward post landed`);
      return done();
    }
    const lines = rewardLines(this.state.tally, this.joins, BigInt(this.d.deployment.params.rewardPerReportUqor));
    if (lines.length === 0) return done();
    const total = lines.reduce((t, l) => t + l.amount, 0n);
    if (me.balance < total) {
      // Keep the tally: these scouts are paid with the next epoch once the pool is topped up.
      this.log(`epoch ending round ${round}: reward pool holds ${me.balance} uqor, needs ${total}; top it up with a deposit`);
      this.state.rewardDue = undefined;
      this.d.store.save(this.state);
      return;
    }
    this.state.rewardPosting = { round, nonce: me.nonce.toString() };
    this.d.store.save(this.state);
    const payloads = lines.map((l, i) =>
      encodeQledgerTx(
        signQledgerTx({ ...this.env, secretKey: this.ledgerKey.secretKey, publicKey: this.ledgerKey.publicKey, nonce: me.nonce + BigInt(i), amount: l.amount, to: l.account }),
      ),
    );
    const tx = await this.d.chain.native.postToInbox(this.d.operator, payloads, this.env.rollupId);
    this.log(`epoch ending round ${round}: paid ${lines.map((l) => `${l.scout} ${l.amount}`).join(", ")} (tx ${tx.txHash})`);
    done();
  }

  /** The ledger including entries posted since the last batch: the base for the next ledger nonce. */
  private headLedger(): QledgerLedger {
    const consumed = this.batches.reduce((m, b) => (b.inboxEnd > m ? b.inboxEnd : m), 0n);
    const head = this.ledger.clone();
    executeQledger(this.env, head, this.entries.filter((e) => e.seq > consumed));
    return head;
  }

  // ---- 4. exit ----

  private async executeWithdrawals(): Promise<void> {
    for (const b of this.batches) {
      const pending = b.withdrawals.filter((w) => !this.state.executed.includes(`${b.batchIndex}:${w.index}`));
      if (pending.length === 0) continue;
      if (b.status !== "finalized") {
        b.status = (await this.rest.getBatch(this.env.rollupId, b.batchIndex)).status;
        if (b.status !== "finalized") continue;
      }
      for (const w of pending) {
        const i = b.withdrawals.indexOf(w);
        const msg = executeWithdrawalMsg({
          submitter: this.d.operator.address,
          rollupId: this.env.rollupId,
          batchIndex: b.batchIndex,
          withdrawalIndex: w.index,
          recipient: w.recipient,
          denom: "uqor",
          amount: w.amount,
          proof: qledgerWithdrawalProof(this.env.chainId, this.env.rollupId, b.withdrawals, i),
        });
        const r = await this.d.chain.native.send(this.d.operator, [msg]);
        this.log(`withdrawal ${w.index} of batch ${b.batchIndex}: ${w.amount} uqor to ${w.recipient}: code ${r.code} tx ${r.txHash} ${r.code ? r.rawLog : ""}`);
        if (r.code === 0 || /already/i.test(r.rawLog)) this.state.executed.push(`${b.batchIndex}:${w.index}`);
      }
      this.d.store.save(this.state);
    }
  }

  // ---- inbox cache ----

  private lastSeq(): bigint {
    return this.entries.at(-1)?.seq ?? 0n;
  }

  private async refreshEntries(): Promise<void> {
    const head = await this.d.chain.inbox.head(this.env.rollupId);
    const from = this.lastSeq() + 1n;
    if (head < from) return;
    const fresh = await this.d.chain.inbox.read(this.env.rollupId, from, head);
    joinsFrom(fresh, this.joins);
    this.entries.push(...fresh);
  }

  /** Keep only what unsettled rounds and the unbatched ledger tail still need. */
  private pruneEntries(height: bigint): void {
    const keepRound = this.state.lastSettled !== undefined ? BigInt(this.state.lastSettled) + 1n : roundOf(height, this.params);
    const fromHeight = roundWindows(keepRound, this.params).start;
    const consumed = this.batches.reduce((m, b) => (b.inboxEnd > m ? b.inboxEnd : m), 0n);
    this.entries = this.entries.filter((e) => e.height >= fromHeight || e.seq > consumed);
  }

  private async loadPqKeys(round: bigint): Promise<void> {
    const w = roundWindows(round, this.params);
    // Deposits enter the inbox under a "deposit:<address>" poster that is not an account: no key to look up.
    const posters = new Set(this.entries.filter((e) => e.height >= w.start && e.height < w.revealEnd && !e.poster.startsWith(QLEDGER_DEPOSIT_POSTER_PREFIX)).map((e) => e.poster));
    for (const p of posters) {
      if (this.pqKeys.has(p)) continue;
      const status = await fetchPqcStatus({ rest: this.d.chain.config.rest, address: p, fetch: this.d.chain.fetch as unknown as typeof fetch });
      const key = status.registered ? pqcStatusPublicKey(status) : undefined;
      if (key) this.pqKeys.set(p, key);
    }
  }

  /** Block time of `height` in unix seconds. */
  private async blockTime(height: bigint): Promise<bigint> {
    const b = await getJson<{ block?: { header?: { time?: string } } }>(
      this.d.chain.fetch,
      `${this.d.chain.config.rest}/cosmos/base/tendermint/v1beta1/blocks/${height}`,
    );
    const t = b.block?.header?.time;
    if (!t) throw new Error(`no time for block ${height}`);
    return BigInt(Math.floor(Date.parse(t) / 1000));
  }
}

function summary(r: RoundResult) {
  return {
    status: r.status,
    medians: r.medians,
    reportsRoot: r.reportsRoot,
    leaves: r.leaves.map((l) => l.scout),
    inBand: r.inBand.map((l) => l.scout),
    outliers: r.outliers.map((l) => l.scout),
    rejected: r.rejected,
    skippedByOpener: r.skippedByOpener,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
