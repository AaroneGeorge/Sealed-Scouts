// The operator loop. One call to tick() does whatever the chain height allows, in order:
//   1. open:   after a round's commit window, post OPEN (the decrypted reports) inside the open window;
//   2. settle: after the reveal window, derive the round, submit the next ledger batch with the round
//              hash as the anchor's validator_set_hash, and relay the round to PriceFeed;
//   3. reward: at the end of each epoch, pay in-band scouts with ledger transfers;
//   4. exit:   execute ledger withdrawals of finalized batches.
// The round clock is the main-chain height (packages/core round.ts), never the local clock.
import {
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
import { getJson, type Account, type Chain, type InboxEntry } from "@sealed-scouts/chain";
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
import { timingOf, type DeploymentFile } from "./deployment.js";
import { replayLedger, type SettledBatch } from "./ledger.js";
import { buildOpenings, openPayload } from "./opener.js";
import { Relayer } from "./relay.js";
import { addInBand, joinsFrom, rewardLines } from "./rewards.js";
import type { OperatorState, StateStore } from "./state.js";

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
  log?: (line: string) => void;
}

export class Operator {
  private readonly rest: RestClient;
  private readonly params: RoundParams;
  private readonly ledgerKey: LedgerKey;
  private readonly relay?: Relayer;
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
      ...timingOf(dep),
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
    this.state = d.store.load();
    this.log = d.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  }

  private get env() {
    return { chainId: this.d.deployment.chainId, rollupId: this.d.deployment.rollupId };
  }

  /** Rebuild the ledger and the JOIN map from the chain. Call once before the first tick. */
  async start(): Promise<void> {
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
    await this.executeWithdrawals();
    this.pruneEntries(height);
  }

  // ---- 1. open ----

  private async openRounds(height: bigint): Promise<void> {
    const current = roundOf(height, this.params);
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

  private async settleRounds(height: bigint): Promise<void> {
    if (this.state.lastOpened === undefined || this.state.lastSettled === undefined) return;
    for (let round = BigInt(this.state.lastSettled) + 1n; round <= BigInt(this.state.lastOpened); round++) {
      if (height < roundWindows(round, this.params).revealEnd) break;
      await this.refreshEntries();
      await this.settle(round);
      this.state.lastSettled = String(round);
      this.d.store.save(this.state);
    }
  }

  private async settle(round: bigint): Promise<void> {
    const dep = this.d.deployment;
    await this.loadPqKeys(round);
    const eligible = new Set(dep.scouts);
    const result = deriveRound(this.entries, round, this.params, (scout) => eligible.has(scout));

    let plan;
    try {
      plan = await planQledgerBatch(this.rest, { ...this.env, submitter: this.d.operator.address, ledger: this.ledger });
    } catch (err) {
      this.log(`round ${round}: no batch now (${(err as Error).message}); the round is recorded but not anchored`);
      this.d.store.saveRound(round, { round, result: summary(result), anchored: false, reason: (err as Error).message });
      return;
    }
    const inboxEnd = plan.input.inboxEnd;
    const att = toAttestation(result, {
      index: plan.input.batchIndex,
      inboxStart: inboxEnd - BigInt(plan.entries.length),
      inboxEnd,
      closeTime: await this.blockTime(result.closeHeight),
    });
    const rh = roundHash(att, { chainId: BigInt(dep.evmChainId), rollupId: dep.rollupId });
    const vsh = fromHex(rh);
    const sig = anchorSignature(this.d.operator, {
      chainId: dep.chainId,
      layerId: dep.rollupId,
      batchIndex: plan.input.batchIndex,
      stateRoot: plan.input.stateRoot,
      txCount: plan.input.txCount,
      validatorSetHash: vsh,
    });
    const tx = await this.d.chain.native.sendOrThrow(this.d.operator, [
      submitBatchMsg({ sequencer: this.d.operator.address, ...plan.input, validatorSetHash: vsh, anchorSignature: sig }),
    ]);
    this.ledger = plan.ledger;
    this.batches.push({
      batchIndex: Number(plan.input.batchIndex),
      status: "submitted",
      inboxStart: att.inboxStart,
      inboxEnd,
      withdrawals: plan.result.withdrawals,
    });
    this.log(`round ${round}: ${result.status}, ${result.leaves.length} reports, batch ${plan.input.batchIndex} (${plan.entries.length} entries) anchored with round hash ${rh.slice(0, 12)}… tx ${tx.txHash}`);

    let relayed: unknown = "skipped: no quorum";
    if (result.status === "ok" && this.relay) {
      try {
        relayed = await this.relay.postRound(att, toHex(plan.input.stateRoot), plan.input.txCount, toHex(sig));
        this.log(`round ${round}: relayed to PriceFeed ${JSON.stringify(relayed, big)}`);
      } catch (err) {
        relayed = `failed: ${(err as Error).message.split("\n")[0]}`;
        this.log(`round ${round}: relay ${relayed}; anyone can relay it later from the round record`);
      }
    } else if (!this.relay) relayed = "skipped: no PriceFeed or relayer configured";

    addInBand(this.state.tally, result);
    if ((round + 1n) % BigInt(dep.params.rewardEpochRounds) === 0n) await this.payRewards(round);

    this.d.store.saveRound(round, {
      round,
      result: summary(result),
      attestation: att,
      roundHash: rh,
      batch: { index: plan.input.batchIndex, stateRoot: toHex(plan.input.stateRoot), txCount: plan.input.txCount, submitTx: tx.txHash },
      anchorSignature: toHex(sig),
      relayed,
    });
  }

  // ---- 3. reward ----

  private async payRewards(round: bigint): Promise<void> {
    const lines = rewardLines(this.state.tally, this.joins, BigInt(this.d.deployment.params.rewardPerReportUqor));
    this.state.tally = {};
    if (lines.length === 0) return;
    const head = this.headLedger();
    const me = head.get(this.ledgerKey.accountId);
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    if (me.balance < total) {
      this.log(`epoch ending round ${round}: reward pool holds ${me.balance} uqor, needs ${total}; top it up with a deposit`);
      return;
    }
    const payloads = lines.map((l, i) =>
      encodeQledgerTx(
        signQledgerTx({ ...this.env, secretKey: this.ledgerKey.secretKey, publicKey: this.ledgerKey.publicKey, nonce: me.nonce + BigInt(i), amount: l.amount, to: l.account }),
      ),
    );
    const tx = await this.d.chain.native.postToInbox(this.d.operator, payloads, this.env.rollupId);
    this.log(`epoch ending round ${round}: paid ${lines.map((l) => `${l.scout} ${l.amount}`).join(", ")} (tx ${tx.txHash})`);
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
    const posters = new Set(this.entries.filter((e) => e.height >= w.start && e.height < w.revealEnd).map((e) => e.poster));
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

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
