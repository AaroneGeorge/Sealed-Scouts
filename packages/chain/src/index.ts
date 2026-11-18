// @sealed-scouts/chain: accounts, the hybrid native lane, the inbox reader and the EVM window.
// `createChain()` builds one set of lanes; `native`, `inbox` and `evm` are the default set (testnet).
import { defaultConfig, type ChainConfig } from "./config.js";
import { politeFetch, type FetchLike } from "./http.js";
import { NativeLane } from "./native.js";
import { InboxReader } from "./inbox.js";
import { EvmLane } from "./evm.js";

export * from "./accounts.js";
export * from "./config.js";
export * from "./http.js";
export * from "./native.js";
export * from "./inbox.js";
export * from "./evm.js";
export * from "./bonds.js";

export interface Chain {
  config: ChainConfig;
  fetch: FetchLike;
  native: NativeLane;
  inbox: InboxReader;
  evm: EvmLane;
}

export function createChain(overrides: Partial<ChainConfig> = {}, fetchImpl?: FetchLike): Chain {
  const config = { ...defaultConfig(), ...overrides };
  const fetch = fetchImpl ?? politeFetch({ userAgent: config.userAgent });
  const native = new NativeLane({ config, fetch });
  return { config, fetch, native, inbox: new InboxReader({ config, fetch }), evm: new EvmLane({ config, fetch, native }) };
}

let defaults: Chain | undefined;
/** The default lanes, built on first use so importing this package does no I/O. */
export function chain(): Chain {
  return (defaults ??= createChain());
}
