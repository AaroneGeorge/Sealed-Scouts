// The EVM lane. QoreChain admits an EVM transaction only inside an authorisation window that the
// account opened with a hybrid-signed native message, so a stolen secp256k1 key alone cannot spend.
// withWindow opens a bounded window, runs the caller's viem code, and always closes it again.
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus, MAX_EVM_WINDOW_TARGETS } from "@qorechain/evm";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Account as ViemAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "./accounts.js";
import type { ChainConfig } from "./config.js";
import type { FetchLike } from "./http.js";
import type { NativeLane, TxResult } from "./native.js";

export interface WindowScope {
  /** Contracts the window may call. Empty = unscoped (needed to deploy a contract). At most 16. */
  targets: `0x${string}`[];
  maxTxs: number;
  /** uqor the window may let out: value plus max fee of every tx. Default: maxTxs x 3M gas at 250 gwei. */
  maxValue?: bigint;
  /** Block count, not a duration (about 1.3 s each on testnet). */
  blocks: number;
}

export interface EvmSession {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, ViemAccount>;
  account: Account;
  chain: Chain;
  opened: TxResult;
}

export function diana(config: ChainConfig): Chain {
  return defineChain({
    id: config.evmChainId,
    name: "QoreChain Testnet (diana)",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [config.evmRpc] } },
  });
}

export class EvmLane {
  readonly chain: Chain;
  readonly publicClient: PublicClient<Transport, Chain>;

  constructor(
    private readonly opts: { config: ChainConfig; fetch: FetchLike; native: NativeLane; pollMs?: number },
  ) {
    this.chain = diana(opts.config);
    this.publicClient = createPublicClient({ chain: this.chain, transport: this.transport() });
  }

  /** Open a window, run `fn`, close the window (also when `fn` throws). Returns what `fn` returns. */
  async withWindow<T>(account: Account, scope: WindowScope, fn: (s: EvmSession) => Promise<T>): Promise<T> {
    const opened = await this.openWindow(account, scope);
    try {
      await this.waitLive(account.address);
      return await fn({ publicClient: this.publicClient, walletClient: this.wallet(account), account, chain: this.chain, opened });
    } finally {
      await this.opts.native.sendOrThrow(account, [closeEvmWindowMsg(account.address)]);
    }
  }

  /**
   * For long-running relayers: keep a window open, replacing it when it has fewer than `minBlocks`
   * blocks or `minTxs` transactions left. Opening a window costs a native tx, so a relayer that
   * posts every round reuses one instead of opening and closing it each time.
   */
  async ensureWindow(account: Account, scope: WindowScope, min: { blocks: number; txs: number }): Promise<TxResult | "still-open"> {
    const w = await this.windowStatus(account.address);
    if (w.live && w.remainingBlocks >= BigInt(min.blocks) && w.remainingTxs >= BigInt(min.txs)) return "still-open";
    const opened = await this.openWindow(account, scope);
    await this.waitLive(account.address);
    return opened;
  }

  /** A viem wallet for the account's EVM lane. Its transactions need a live window. */
  wallet(account: Account): WalletClient<Transport, Chain, ViemAccount> {
    return createWalletClient({
      account: privateKeyToAccount(account.keys.privateKey as `0x${string}`),
      chain: this.chain,
      transport: this.transport(),
    });
  }

  private openWindow(account: Account, scope: WindowScope): Promise<TxResult> {
    if (scope.targets.length > MAX_EVM_WINDOW_TARGETS) throw new Error(`at most ${MAX_EVM_WINDOW_TARGETS} targets`);
    const maxValue =
      scope.maxValue ?? evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n }) * BigInt(scope.maxTxs);
    const open = openEvmWindowMsg({
      sender: account.address,
      blocks: scope.blocks,
      maxTxs: scope.maxTxs,
      maxValue,
      ...(scope.targets.length > 0 ? { allowedTargets: scope.targets } : {}),
    });
    return this.opts.native.sendOrThrow(account, [open]);
  }

  private windowStatus(address: string) {
    return evmWindowStatus({ rest: this.opts.config.rest, address, fetch: this.opts.fetch as unknown as typeof globalThis.fetch });
  }

  private async waitLive(address: string): Promise<void> {
    const poll = this.opts.pollMs ?? 1500;
    for (let i = 0; i < 20; i++) {
      if ((await this.windowStatus(address)).live) return;
      await new Promise((r) => setTimeout(r, poll));
    }
    throw new Error(`the EVM window of ${address} did not become live`);
  }

  private transport() {
    return http(this.opts.config.evmRpc, {
      fetchOptions: { headers: { "user-agent": this.opts.config.userAgent } },
      retryCount: 4,
      retryDelay: 800,
    });
  }
}
