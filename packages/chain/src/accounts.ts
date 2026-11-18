import { deriveUnifiedAccount, validateMnemonic, type UnifiedAccount } from "@qorechain/sdk";

/** Every key the project uses. One BIP-39 mnemonic per role, kept only in the server secret store. */
export const ROLES = [
  "OPERATOR",
  "SCOUT1",
  "SCOUT2",
  "SCOUT3",
  "SCOUT4",
  "SCOUT5",
  "TOWER",
  "ROGUE",
  "ATTACKER",
  "RELAYER",
] as const;
export type Role = (typeof ROLES)[number];

export function mnemonicEnvName(role: Role): string {
  return `SS_${role}_MNEMONIC`;
}

/**
 * An eth-native unified account: one secp256k1 key for the native and EVM lanes, plus the
 * ML-DSA-87 key the SDK derives from the same mnemonic. The key material sits in a
 * non-enumerable field so logging or serialising an Account never prints a secret.
 */
export interface Account {
  readonly role: Role | "CUSTOM";
  /** qor1… native address. */
  readonly address: string;
  /** 0x… EVM address (EIP-55). */
  readonly evm: `0x${string}`;
  /** Full key material. Never log it. */
  readonly keys: UnifiedAccount;
}

export function wrapAccount(role: Role | "CUSTOM", keys: UnifiedAccount): Account {
  const account = { role, address: keys.cosmos, evm: keys.evm as `0x${string}` };
  Object.defineProperty(account, "keys", { value: keys, enumerable: false });
  const shown = () => ({ role, address: keys.cosmos, evm: keys.evm });
  Object.defineProperty(account, "toJSON", { value: shown, enumerable: false });
  Object.defineProperty(account, Symbol.for("nodejs.util.inspect.custom"), { value: shown, enumerable: false });
  return account as Account;
}

export async function accountFromMnemonic(role: Role | "CUSTOM", mnemonic: string): Promise<Account> {
  const m = mnemonic.trim();
  if (!validateMnemonic(m)) throw new Error(`the mnemonic for ${role} is not a valid BIP-39 phrase`);
  return wrapAccount(role, await deriveUnifiedAccount(m, 0));
}

/** Load a role's account from its SS_<ROLE>_MNEMONIC environment variable. */
export async function loadAccount(role: Role, env: NodeJS.ProcessEnv = process.env): Promise<Account> {
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`unknown role ${role}`);
  const name = mnemonicEnvName(role);
  const mnemonic = env[name];
  if (!mnemonic) throw new Error(`${name} is not set (source ops/env.local.sh first)`);
  return accountFromMnemonic(role, mnemonic);
}
