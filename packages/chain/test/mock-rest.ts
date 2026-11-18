// A small in-memory stand-in for the QoreChain REST API: accounts, simulate, broadcast, tx lookup.
import { AuthInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { registry } from "../src/native.js";
import type { FetchLike, HttpResponse } from "../src/http.js";

export const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

export interface SeenTx {
  hash: string;
  sequence: bigint;
  hybrid: boolean;
  typeUrls: string[];
  gas: bigint;
  feeUqor: bigint;
}

export class MockRest {
  sequences = new Map<string, bigint>();
  broadcasts: SeenTx[] = [];
  simulations = 0;
  inboxHead = 0n;
  /** Make the next broadcast see a sequence moved by someone else. */
  bumpSequenceOnce?: string;
  simulateError?: string;
  /** Registered ML-KEM keys, hex, by address. */
  kemKeys = new Map<string, string>();
  private txs = new Map<string, object>();

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const acc = /\/cosmos\/auth\/v1beta1\/accounts\/(\w+)$/.exec(u.pathname);
    if (acc) {
      const seq = this.sequences.get(acc[1]!);
      if (seq === undefined) return reply(404, { code: 5, message: "not found" });
      return reply(200, { account: { "@type": "/cosmos.auth.v1beta1.BaseAccount", account_number: "7", sequence: String(seq) } });
    }
    const kem = /\/qorechain\/pqc\/v1\/kem\/(\w+)$/.exec(u.pathname);
    if (kem) {
      const pk = this.kemKeys.get(kem[1]!);
      return reply(200, pk ? { found: true, key: { address: kem[1], algorithm_id: 2, public_key: Buffer.from(pk, "hex").toString("base64") } } : { found: false });
    }
    if (u.pathname === "/cosmos/tx/v1beta1/simulate") {
      this.simulations++;
      if (this.simulateError) return reply(400, { code: 4, message: this.simulateError });
      return reply(200, { gas_info: { gas_used: "100000" } });
    }
    if (u.pathname === "/cosmos/tx/v1beta1/txs" && init?.method === "POST") return reply(200, { tx_response: this.broadcast(body.tx_bytes) });
    const get = /\/cosmos\/tx\/v1beta1\/txs\/(\w+)$/.exec(u.pathname);
    if (get) {
      const tx = this.txs.get(get[1]!);
      return tx ? reply(200, { tx_response: tx }) : reply(404, { code: 5, message: "tx not found" });
    }
    return reply(404, { message: `no mock for ${u.pathname}` });
  };

  private broadcast(txBytes: string) {
    const raw = TxRaw.decode(Buffer.from(txBytes, "base64"));
    const body = TxBody.decode(raw.bodyBytes);
    const auth = AuthInfo.decode(raw.authInfoBytes);
    const signer = registry.decode(body.messages[0]!) as Record<string, string>;
    const address = signer.sender ?? signer.poster ?? signer.fromAddress;
    const sequence = auth.signerInfos[0]!.sequence;
    const hybrid = body.extensionOptions.length > 0;
    const typeUrls = body.messages.map((m) => m.typeUrl);
    const hash = `${String(this.broadcasts.length).padStart(4, "0")}${"ab".repeat(30)}`.toUpperCase();
    this.broadcasts.push({ hash, sequence, hybrid, typeUrls, gas: auth.fee!.gasLimit, feeUqor: BigInt(auth.fee!.amount[0]!.amount) });

    if (this.bumpSequenceOnce === address) {
      this.bumpSequenceOnce = undefined;
      this.sequences.set(address, this.sequences.get(address)! + 1n);
    }
    const expected = this.sequences.get(address)!;
    if (sequence !== expected) {
      return { txhash: hash, code: 32, codespace: "sdk", raw_log: `account sequence mismatch, expected ${expected}, got ${sequence}: incorrect account sequence` };
    }
    if (!hybrid && !typeUrls.every((t) => t.endsWith("MsgRegisterPQCKeyV2"))) {
      return { txhash: hash, code: 13, codespace: "pqc", raw_log: "hybrid signature required" };
    }
    this.sequences.set(address, expected + 1n);
    const events = body.messages
      .filter((m) => m.typeUrl === "/qorechain.rdk.v1.MsgPostRollupData")
      .map((m) => {
        const msg = registry.decode(m) as { rollupId: string };
        this.inboxHead++;
        return { type: "rdk_data_posted", attributes: [{ key: "rollup_id", value: msg.rollupId }, { key: "sequence", value: String(this.inboxHead) }] };
      });
    this.txs.set(hash, { txhash: hash, code: 0, height: "1000", gas_used: "90000", gas_wanted: String(auth.fee!.gasLimit), events });
    return { txhash: hash, code: 0, codespace: "" };
  }
}

function reply(status: number, json: unknown): Promise<HttpResponse> {
  const text = JSON.stringify(json);
  return Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => JSON.parse(text), text: async () => text });
}
