// Create one mnemonic per role (only if missing), store it in the server secret store, read it back,
// and print role -> addresses. Mnemonics and keys are never printed.
//   npx tsx ops/keys.ts [--addresses-md <path>]
import { writeFileSync } from "node:fs";
import { generateMnemonic } from "@qorechain/sdk";
import { ROLES, accountFromMnemonic, mnemonicEnvName, type Account } from "../packages/chain/src/accounts.js";
import { readSecret, secretNames, writeSecret } from "./secrets.js";

const existing = new Set(secretNames());
const accounts: Account[] = [];
for (const role of ROLES) {
  const key = mnemonicEnvName(role);
  let created = false;
  if (!existing.has(key)) {
    const fresh = generateMnemonic(256);
    const expected = (await accountFromMnemonic(role, fresh)).address;
    writeSecret(key, fresh);
    const back = await accountFromMnemonic(role, readSecret(key));
    if (back.address !== expected) throw new Error(`${key}: the stored phrase does not derive the same address`);
    created = true;
  }
  const account = await accountFromMnemonic(role, readSecret(key));
  accounts.push(account);
  console.log(`${role.padEnd(9)} ${account.address} ${account.evm}${created ? "  (new)" : ""}`);
}

const out = process.argv.indexOf("--addresses-md");
if (out > 0) {
  const rows = accounts.map((a) => `| ${a.role} | \`${a.address}\` | \`${a.evm}\` |`).join("\n");
  writeFileSync(
    process.argv[out + 1]!,
    `# Sealed Scouts: addresses (testnet qorechain-diana)\n\n` +
      `Created ${new Date().toISOString().slice(0, 10)} with repo/ops/keys.ts. Eth-native unified accounts ` +
      `(BIP-44 m/44'/60'/0'/0/0, ML-DSA-87 derived from the same mnemonic). One mnemonic per role, stored only ` +
      `in the server secret store as qorechain/SS_<ROLE>_MNEMONIC.\n\n` +
      `| Role | Native (qor1) | EVM (0x) |\n|---|---|---|\n${rows}\n`,
  );
  console.log(`wrote ${process.argv[out + 1]}`);
}
