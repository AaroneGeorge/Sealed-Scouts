// What an attacker can build without a scout's ML-DSA-87 key: a REPORT sealed to the opener (its key is public)
// and a COMMIT for the victim's address, signed with a key the attacker does have. The prices say fETH = $1.
import { buildSealedReport, type ScoutSigner } from "@sealed-scouts/scout";

export const ONE_DOLLAR = 100_000_000n;
export const FORGED_PRICES = { feedIds: [1, 2, 3], prices: [ONE_DOLLAR, ONE_DOLLAR, ONE_DOLLAR] };

export function forgedReport(input: { chainId: string; rollupId: string; round: bigint; victim: string; attackerPq: ScoutSigner["keys"]; openerKemKey: Uint8Array }) {
  return buildSealedReport({
    chainId: input.chainId, rollupId: input.rollupId, round: input.round, openerKemKey: input.openerKemKey, prices: FORGED_PRICES,
    scout: { address: input.victim, keys: input.attackerPq },
  });
}
