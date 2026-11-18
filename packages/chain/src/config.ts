/** Network settings. Testnet only: every default points at qorechain-diana. */
export interface ChainConfig {
  chainId: string;
  rest: string;
  evmRpc: string;
  evmChainId: number;
  userAgent: string;
  /** uqor per unit of gas for native-lane fees. The chain floor is 0.1. */
  gasPriceUqor: number;
  /** Default rollup for inbox posts and reads (deployments/diana.json once our rollup exists). */
  rollupId?: string;
  /** Hybrid sign-bytes form. "auto" asks the chain once; tests force "v2". */
  signBytesVersion: "auto" | "v1" | "v2";
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): ChainConfig {
  const chainId = env.QORE_CHAIN_ID ?? "qorechain-diana";
  if (chainId !== "qorechain-diana") throw new Error(`refusing chain ${chainId}: this project runs on testnet only`);
  return {
    chainId,
    rest: env.QORE_REST ?? "https://api-testnet.qore.host",
    evmRpc: env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host",
    evmChainId: 9800,
    userAgent: "sealed-scouts/0.1",
    gasPriceUqor: Number(env.QORE_GAS_PRICE_UQOR ?? "0.15"),
    rollupId: env.SS_ROLLUP_ID,
    signBytesVersion: "auto",
  };
}
