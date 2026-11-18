// The native (Cosmos) lane: hybrid-signed transactions from eth-native accounts, one queue per account.
// Signing uses the SDK's EthNativeSigner with a registry that also knows the v3.2.8 rollup messages
// (the SDK's default registry lacks them). Broadcasting goes over REST so every call is polite and mockable.
import type { EncodeObject } from "@cosmjs/proto-signing";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  exactHybridGas,
  fetchPqcStatus,
  isRegisteredPqcKey,
  qorechainRegistry,
  signProofOfPossession,
  type SignBytesVersion,
} from "@qorechain/sdk";
import { QLEDGER_MAX_POST_BYTES, RDK_TYPES, RestClient, postRollupDataMsg, registerKemKeyMsg } from "@qorechain/rdk";
import { deriveSealKeys } from "@qorechain/qoreseal";
import type { Account } from "./accounts.js";
import type { ChainConfig } from "./config.js";
import { HttpError, getJson, type FetchLike } from "./http.js";

export const registry = qorechainRegistry(RDK_TYPES);

export interface TxResult {
  txHash: string;
  /** 0 = success. Anything else is the chain's refusal (CheckTx or DeliverTx). */
  code: number;
  codespace: string;
  /** 0 when the chain refused the transaction before a block. */
  height: bigint;
  gasUsed: bigint;
  gasWanted: bigint;
  rawLog: string;
  events: TxEvent[];
}
export interface TxEvent {
  type: string;
  attributes: { key: string; value: string }[];
}

export interface SendOptions {
  /** "classical" omits the ML-DSA-87 half: only for key registration, or to show the chain refusing it. */
  mode?: "hybrid" | "classical";
  /** A fixed gas limit. Without it the tx is simulated first and nothing is sent if simulation fails. */
  gas?: number;
  memo?: string;
}

/** Raised when the chain refuses a simulation: nothing was broadcast and no fee was paid. */
export class SimulationError extends Error {}

/** Cosmos SDK error 32: the signer's sequence moved (another process, or a tx we did not see land). */
const WRONG_SEQUENCE = 32;
const SEQUENCE_RETRIES = 3;
const SIMULATION_GAS = 3_000_000;

interface Seq {
  accountNumber: bigint;
  sequence: bigint;
}

export interface NativeLaneOptions {
  config: ChainConfig;
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a tx to land in a block. */
  inclusionTimeoutMs?: number;
  pollMs?: number;
}

export class NativeLane {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly seqs = new Map<string, Seq>();
  private signBytes?: Promise<SignBytesVersion>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: NativeLaneOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Sign and send `msgs` in one transaction. Chain refusals come back as a non-zero `code`. */
  send(account: Account, msgs: EncodeObject[], options: SendOptions = {}): Promise<TxResult> {
    return this.enqueue(account.address, () => this.sendNow(account, msgs, options));
  }

  /** Like send, but a non-zero code is thrown. */
  async sendOrThrow(account: Account, msgs: EncodeObject[], options: SendOptions = {}): Promise<TxResult> {
    const r = await this.send(account, msgs, options);
    if (r.code !== 0) throw new Error(`tx ${r.txHash} refused: code ${r.code} (${r.codespace}) ${r.rawLog}`);
    return r;
  }

  /**
   * Post n payloads to a rollup inbox in ONE transaction (n MsgPostRollupData). Returns the inbox
   * sequence the chain gave each payload, in order.
   */
  async postToInbox(
    account: Account,
    payloads: Uint8Array[],
    rollupId = this.opts.config.rollupId,
  ): Promise<TxResult & { sequences: bigint[] }> {
    if (!rollupId) throw new Error("postToInbox needs a rollup id (argument, or SS_ROLLUP_ID)");
    if (payloads.length === 0) throw new Error("postToInbox needs at least one payload");
    for (const p of payloads) {
      if (p.length === 0 || p.length > QLEDGER_MAX_POST_BYTES) {
        throw new Error(`payload of ${p.length} bytes is outside 1..${QLEDGER_MAX_POST_BYTES}`);
      }
    }
    const msgs = payloads.map((data) => postRollupDataMsg({ poster: account.address, rollupId, data }));
    const r = await this.sendOrThrow(account, msgs);
    return { ...r, sequences: postedSequences(r.events, rollupId) };
  }

  /**
   * Register the account's ML-DSA-87 key with a proof of possession. This is the one message the
   * chain accepts signed classically. A no-op when this key is already registered.
   */
  async registerPqcKey(account: Account): Promise<TxResult | "already-registered"> {
    const { chainId, rest } = this.opts.config;
    const status = await fetchPqcStatus({ rest, address: account.address, fetch: this.sdkFetch });
    if (status.registered) {
      if (isRegisteredPqcKey(status, account.keys.pqc.publicKey) === false) {
        throw new Error(`${account.address} already has a different ML-DSA-87 key on chain`);
      }
      return "already-registered";
    }
    const proofOfPossession = signProofOfPossession({ chainId, account: account.address, keypair: account.keys.pqc });
    const msg = buildRegisterPqcKeyMsg(account.address, { pqcKeypair: account.keys.pqc, proofOfPossession });
    return this.sendOrThrow(account, [msg], { mode: "classical" });
  }

  /**
   * Publish the account's ML-KEM-1024 key (QoreSeal key index 0 of its mnemonic). Sent as a message
   * object through our registry: QoreSeal's own builder returns pre-encoded bytes the eth-native
   * signer cannot embed.
   */
  async registerKemKey(account: Account, index = 0): Promise<TxResult | "already-registered"> {
    const publicKey = sealKeys(account, index).mlkemPublicKey;
    const current = await this.kemKey(account.address);
    if (current && current === toHexLower(publicKey)) return "already-registered";
    return this.sendOrThrow(account, [registerKemKeyMsg({ sender: account.address, publicKey })]);
  }

  /** The registered ML-KEM key of `address` as lowercase hex, or undefined when it has none. */
  async kemKey(address: string): Promise<string | undefined> {
    const view = await new RestClient(this.opts.config.rest, { fetch: this.opts.fetch }).getKemKey(address);
    return view?.publicKey ? view.publicKey.replace(/^0x/, "").toLowerCase() : undefined;
  }

  /** Current balance in uqor. A failed read throws. */
  async balance(address: string): Promise<bigint> {
    const r = await getJson<{ balance?: { amount?: string } }>(
      this.opts.fetch,
      `${this.opts.config.rest}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`,
    );
    if (!r.balance) throw new Error(`no balance field for ${address}`);
    return BigInt(r.balance.amount ?? "0");
  }

  /**
   * Forget the cached sequence of `address`. Call it after EVM transactions: the account's EVM nonce and
   * its native sequence are the same counter, so EVM txs move it without this lane seeing them.
   */
  resync(address: string): void {
    this.seqs.delete(address);
  }

  // ---- internals ----

  private get sdkFetch() {
    return this.opts.fetch as unknown as typeof globalThis.fetch;
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async sendNow(account: Account, msgs: EncodeObject[], options: SendOptions): Promise<TxResult> {
    const mode = options.mode ?? "hybrid";
    try {
      for (let attempt = 0; ; attempt++) {
        const seq = await this.sequence(account.address);
        const gas = options.gas ?? (await this.simulate(account, msgs, seq, mode, options.memo));
        const tx = await this.sign(account, msgs, seq, mode, gas, options.memo);
        const sync = await this.broadcastSync(tx);
        if (sync.code === WRONG_SEQUENCE && sync.codespace === "sdk" && attempt < SEQUENCE_RETRIES) {
          this.seqs.set(account.address, { ...seq, sequence: expectedSequence(sync.rawLog) ?? seq.sequence + 1n });
          continue;
        }
        if (sync.code !== 0) return sync;
        // Accepted into the mempool: the sequence is used whether the tx succeeds or fails in the block.
        this.seqs.set(account.address, { ...seq, sequence: seq.sequence + 1n });
        return await this.waitForInclusion(sync.txHash);
      }
    } catch (err) {
      this.seqs.delete(account.address);
      throw err;
    }
  }

  private async sequence(address: string): Promise<Seq> {
    const known = this.seqs.get(address);
    if (known) return known;
    let body: { account?: Record<string, unknown> };
    try {
      body = await getJson(this.opts.fetch, `${this.opts.config.rest}/cosmos/auth/v1beta1/accounts/${address}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw new Error(`${address} does not exist on chain yet: fund it first`);
      throw err;
    }
    const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
    if (acc.account_number === undefined) throw new Error(`account ${address}: no account_number in the answer`);
    const seq = { accountNumber: BigInt(acc.account_number), sequence: BigInt(acc.sequence ?? "0") };
    this.seqs.set(address, seq);
    return seq;
  }

  private async sign(
    account: Account,
    msgs: EncodeObject[],
    seq: Seq,
    mode: "hybrid" | "classical",
    gas: number,
    memo?: string,
  ): Promise<Uint8Array> {
    const { chainId, rest, gasPriceUqor, signBytesVersion } = this.opts.config;
    const signer = new EthNativeSigner(account.keys, {
      registry,
      signMode: mode,
      signBytesVersion,
      rest,
      fetch: this.sdkFetch,
    });
    this.signBytes ??= signer.resolveSignBytesVersion(chainId);
    const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * gasPriceUqor)) }], gas: String(gas) };
    return signer.sign({
      chainId,
      accountNumber: seq.accountNumber,
      sequence: seq.sequence,
      messages: msgs,
      fee,
      memo,
      signBytesVersion: await this.signBytes,
    }).txRawBytes;
  }

  private async simulate(
    account: Account,
    msgs: EncodeObject[],
    seq: Seq,
    mode: "hybrid" | "classical",
    memo?: string,
  ): Promise<number> {
    const tx = await this.sign(account, msgs, seq, mode, SIMULATION_GAS, memo);
    try {
      const r = await getJson<{ gas_info?: { gas_used?: string } }>(
        this.opts.fetch,
        `${this.opts.config.rest}/cosmos/tx/v1beta1/simulate`,
        { tx_bytes: Buffer.from(tx).toString("base64") },
      );
      const used = Number(r.gas_info?.gas_used ?? NaN);
      if (!Number.isFinite(used) || used <= 0) throw new SimulationError("simulation returned no gas_used");
      return exactHybridGas(used);
    } catch (err) {
      if (err instanceof HttpError) {
        const expected = expectedSequence(err.message);
        if (expected !== undefined && expected !== seq.sequence) {
          this.seqs.set(account.address, { ...seq, sequence: expected });
          return this.simulate(account, msgs, { ...seq, sequence: expected }, mode, memo);
        }
        throw new SimulationError(`the chain refused the simulation, nothing was sent: ${err.message}`);
      }
      throw err;
    }
  }

  private async broadcastSync(tx: Uint8Array): Promise<TxResult> {
    const r = await getJson<{ tx_response: RawTxResponse }>(this.opts.fetch, `${this.opts.config.rest}/cosmos/tx/v1beta1/txs`, {
      tx_bytes: Buffer.from(tx).toString("base64"),
      mode: "BROADCAST_MODE_SYNC",
    });
    return mapTxResponse(r.tx_response);
  }

  private async waitForInclusion(txHash: string): Promise<TxResult> {
    const timeout = this.opts.inclusionTimeoutMs ?? 60_000;
    const poll = this.opts.pollMs ?? 1500;
    for (let waited = 0; waited <= timeout; waited += poll) {
      await this.sleep(poll);
      try {
        const r = await getJson<{ tx_response: RawTxResponse }>(
          this.opts.fetch,
          `${this.opts.config.rest}/cosmos/tx/v1beta1/txs/${txHash}`,
        );
        return mapTxResponse(r.tx_response);
      } catch (err) {
        if (!(err instanceof HttpError && (err.status === 404 || err.status === 400))) throw err;
      }
    }
    throw new Error(`tx ${txHash} was accepted but not seen in a block within ${timeout} ms`);
  }
}

interface RawTxResponse {
  txhash: string;
  code?: number;
  codespace?: string;
  height?: string;
  gas_used?: string;
  gas_wanted?: string;
  raw_log?: string;
  events?: TxEvent[];
}

function mapTxResponse(r: RawTxResponse): TxResult {
  return {
    txHash: r.txhash,
    code: r.code ?? 0,
    codespace: r.codespace ?? "",
    height: BigInt(r.height ?? "0"),
    gasUsed: BigInt(r.gas_used ?? "0"),
    gasWanted: BigInt(r.gas_wanted ?? "0"),
    rawLog: r.raw_log ?? "",
    events: r.events ?? [],
  };
}

/** "account sequence mismatch, expected 7, got 6" -> 7n. */
export function expectedSequence(log: string): bigint | undefined {
  const m = /expected (\d+), got \d+/.exec(log);
  return m ? BigInt(m[1]!) : undefined;
}

/** Inbox sequences from the rdk_data_posted events of a tx, in message order. */
export function postedSequences(events: TxEvent[], rollupId: string): bigint[] {
  const out: bigint[] = [];
  for (const ev of events) {
    if (ev.type !== "rdk_data_posted") continue;
    const a = Object.fromEntries(ev.attributes.map((x) => [x.key, x.value]));
    if (a.rollup_id === rollupId && a.sequence !== undefined) out.push(BigInt(a.sequence));
  }
  return out;
}

/** The account's QoreSeal key pair (ML-KEM-1024 + X25519) for `index`, from its mnemonic. */
export function sealKeys(account: Account, index = 0) {
  if (!account.keys.mnemonic) throw new Error(`${account.role} has no mnemonic to derive seal keys from`);
  return deriveSealKeys({ mnemonic: account.keys.mnemonic, index });
}

function toHexLower(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}
