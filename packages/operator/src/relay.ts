// Relays a round to PriceFeed.postRound through a long-lived EVM window scoped to the PriceFeed only.
import { existsSync, readFileSync } from "node:fs";
import { parseAbi, type Abi, type Hex } from "viem";
import type { Account, Chain } from "@sealed-scouts/chain";
import { ROUND_ATTESTATION_ABI, type RoundAttestation } from "@sealed-scouts/core";

const OUT_ABI = new URL("../../../contracts/out-abi/PriceFeed.json", import.meta.url).pathname;
const ATT = `(${ROUND_ATTESTATION_ABI.components.map((c) => `${c.type} ${c.name}`).join(", ")})`;

/** Track B's exported ABI when present; otherwise the two functions the relay needs, as docs/SPEC.md names them. */
export function priceFeedAbi(): Abi {
  if (existsSync(OUT_ABI)) {
    const j = JSON.parse(readFileSync(OUT_ABI, "utf8"));
    return (Array.isArray(j) ? j : j.abi) as Abi;
  }
  return parseAbi([`function postRound(${ATT} att, bytes32 stateRoot, uint64 txCount, bytes anchorSig)`, "function bondOperator() payable"]);
}

/** postRound gas: estimate plus 15%. Kept tight because the EVM may bill a share of the limit, not of use. */
const GAS_MARGIN_PCT = 115n;

export class Relayer {
  private readonly abi = priceFeedAbi();

  constructor(
    private readonly chain: Chain,
    private readonly account: Account,
    private readonly priceFeed: `0x${string}`,
  ) {}

  async postRound(att: RoundAttestation, stateRoot: Hex, txCount: bigint, anchorSig: Hex): Promise<{ hash: Hex; gasUsed: bigint; status: string }> {
    await this.chain.evm.ensureWindow(this.account, { targets: [this.priceFeed], maxTxs: 200, blocks: 17_280 }, { blocks: 30, txs: 1 });
    const pub = this.chain.evm.publicClient;
    const args = [att, stateRoot, txCount, anchorSig] as const;
    const gas = await pub.estimateContractGas({ address: this.priceFeed, abi: this.abi, functionName: "postRound", args, account: this.account.evm });
    const hash = await this.chain.evm.wallet(this.account).writeContract({
      address: this.priceFeed,
      abi: this.abi,
      functionName: "postRound",
      args,
      gas: (gas * GAS_MARGIN_PCT) / 100n,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    this.chain.native.resync(this.account.address);
    return { hash, gasUsed: rc.gasUsed, status: rc.status };
  }
}
