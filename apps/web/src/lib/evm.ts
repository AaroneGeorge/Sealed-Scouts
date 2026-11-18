import { decodeFunctionResult, encodeFunctionData, type Abi } from "viem";
import type { Hex } from "./types";

export const EVM_RPC = "https://evm-testnet.qore.host";
export const EVM_CHAIN_ID = 9800;
export const PQC_VERIFY = "0x0000000000000000000000000000000000000a01";
export const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02";
/** Algorithm id 1 is ML-DSA-87 (Dilithium-5) in the chain's PQC registry. */
export const ML_DSA_87 = 1;

export const precompileAbi = [
  { type: "function", name: "pqcVerify", stateMutability: "view",
    inputs: [{ name: "pubkey", type: "bytes" }, { name: "signature", type: "bytes" }, { name: "message", type: "bytes" }],
    outputs: [{ name: "valid", type: "bool" }] },
  { type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "registered", type: "bool" }, { name: "algorithmId", type: "uint8" }, { name: "pubkey", type: "bytes" },
      { name: "possessionProven", type: "bool" }] },
] as const satisfies Abi;

const attestationType = {
  type: "tuple", name: "att",
  components: [
    { name: "round", type: "uint64" }, { name: "batchIndex", type: "uint64" }, { name: "inboxStart", type: "uint64" },
    { name: "inboxEnd", type: "uint64" }, { name: "closeHeight", type: "uint64" }, { name: "closeTime", type: "uint64" },
    { name: "feedIds", type: "uint16[]" }, { name: "medians", type: "uint128[]" }, { name: "counts", type: "uint8[]" },
    { name: "reportsRoot", type: "bytes32" }, { name: "reportCount", type: "uint16" },
  ],
} as const;

/** The read side of PriceFeed.sol, as frozen in docs/SPEC.md. */
export const priceFeedAbi = [
  { type: "function", name: "verifyReceipt", stateMutability: "view",
    inputs: [attestationType, { name: "stateRoot", type: "bytes32" }, { name: "txCount", type: "uint64" }, { name: "anchorSig", type: "bytes" }],
    outputs: [{ type: "bool" }] },
  { type: "function", name: "latest", stateMutability: "view", inputs: [{ name: "feedId", type: "uint16" }],
    outputs: [{ name: "price", type: "uint128" }, { name: "round", type: "uint64" }, { name: "time", type: "uint64" }, { name: "status", type: "uint8" }] },
  { type: "function", name: "readFinal", stateMutability: "view",
    inputs: [{ name: "feedId", type: "uint16" }, { name: "maxAge", type: "uint64" }],
    outputs: [{ name: "price", type: "uint128" }, { name: "round", type: "uint64" }] },
] as const satisfies Abi;

export class RpcError extends Error {
  constructor(message: string, public data?: Hex) {
    super(message);
  }
}

export type RpcFn = (method: string, params: unknown[]) => Promise<unknown>;

/** A bare JSON-RPC call. The EVM endpoint allows browser origins, so no wallet and no proxy are needed. */
export function httpRpc(url = EVM_RPC, fetchImpl: typeof fetch = (...a) => fetch(...a)): RpcFn {
  let id = 0;
  return async (method, params) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) throw new RpcError(`EVM endpoint answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message: string; data?: Hex } };
    if (body.error) throw new RpcError(body.error.message, body.error.data);
    return body.result;
  };
}

/** eth_call with typed encode and decode. Empty return data is an error, never a silent false. */
export async function readContract<const A extends Abi>(rpc: RpcFn, to: Hex, abi: A, functionName: string, args: readonly unknown[]) {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const result = (await rpc("eth_call", [{ to, data }, "latest"])) as Hex;
  if (!result || result === "0x") throw new RpcError(`${functionName} returned no data`);
  return { data, result: decodeFunctionResult({ abi, functionName, data: result } as never) as unknown };
}
