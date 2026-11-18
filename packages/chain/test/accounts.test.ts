import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ROLES, loadAccount, mnemonicEnvName } from "../src/accounts.js";
import { TEST_MNEMONIC } from "./mock-rest.js";

describe("accounts", () => {
  it("has one env var per role", () => {
    expect(ROLES).toHaveLength(10);
    expect(mnemonicEnvName("SCOUT3")).toBe("SS_SCOUT3_MNEMONIC");
  });

  it("derives the eth-native account the official kits derive (m/44'/60'/0'/0/0)", async () => {
    const a = await loadAccount("OPERATOR", { SS_OPERATOR_MNEMONIC: TEST_MNEMONIC });
    // Well-known first address of the BIP-39 test mnemonic on the Ethereum path.
    expect(a.evm).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    expect(a.address.startsWith("qor1")).toBe(true);
    expect(a.keys.pqc.publicKey).toHaveLength(2592);
  });

  it("never prints key material", async () => {
    const a = await loadAccount("SCOUT1", { SS_SCOUT1_MNEMONIC: TEST_MNEMONIC });
    for (const shown of [JSON.stringify(a), inspect(a, { depth: 5 }), String(Object.keys(a))]) {
      expect(shown).not.toContain(a.keys.privateKey.slice(2));
      expect(shown).not.toContain("abandon");
    }
  });

  it("fails clearly when the env var is missing or bad", async () => {
    await expect(loadAccount("TOWER", {})).rejects.toThrow(/SS_TOWER_MNEMONIC is not set/);
    await expect(loadAccount("TOWER", { SS_TOWER_MNEMONIC: "not a phrase" })).rejects.toThrow(/not a valid BIP-39/);
  });
});
