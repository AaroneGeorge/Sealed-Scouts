// The operator's copy of the rollup ledger, rebuilt from chain data on start: every settled batch is
// re-executed from its inbox range and must reproduce the state root the chain stores.
import { QledgerLedger, bytesToHex, decodeWireBytes, executeQledger, type QledgerWithdrawal, type RestClient } from "@qorechain/rdk";
import type { InboxEntry, InboxReader } from "@sealed-scouts/chain";

export interface SettledBatch {
  batchIndex: number;
  status: string;
  /** Inbox range the batch consumed: (inboxStart, inboxEnd]. */
  inboxStart: bigint;
  inboxEnd: bigint;
  withdrawals: QledgerWithdrawal[];
}

export async function replayLedger(
  env: { chainId: string; rollupId: string },
  rest: RestClient,
  inbox: InboxReader,
): Promise<{ ledger: QledgerLedger; batches: SettledBatch[]; entries: InboxEntry[] }> {
  // A rejected batch was rolled back with its inbox range, so a later batch consumes that range again.
  const views = (await rest.listBatches(env.rollupId)).filter((b) => b.status !== "rejected").sort((a, b) => a.batchIndex - b.batchIndex);
  const end = views.reduce((m, b) => (BigInt(b.inboxEnd) > m ? BigInt(b.inboxEnd) : m), 0n);
  const entries = end > 0n ? await inbox.read(env.rollupId, 1n, end) : [];
  const ledger = new QledgerLedger();
  const batches: SettledBatch[] = [];
  for (const b of views) {
    const start = BigInt(b.inboxStart);
    const stop = BigInt(b.inboxEnd);
    const slice = entries.filter((e) => e.seq > start && e.seq <= stop);
    const result = executeQledger(env, ledger, slice);
    if (bytesToHex(result.stateRoot) !== bytesToHex(decodeWireBytes(b.stateRoot))) {
      throw new Error(`replay of batch ${b.batchIndex} gives root ${bytesToHex(result.stateRoot)}, the chain holds ${b.stateRoot}`);
    }
    batches.push({ batchIndex: b.batchIndex, status: b.status, inboxStart: start, inboxEnd: stop, withdrawals: result.withdrawals });
  }
  return { ledger, batches, entries };
}
