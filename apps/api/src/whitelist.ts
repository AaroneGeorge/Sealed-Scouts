/**
 * The only QoreChain REST reads the proxy forwards. Everything else is refused, so the proxy cannot be used as an
 * open relay. TTLs are short for moving data (heads, latest batch) and longer for data that rarely changes.
 */
const ID = "[a-z0-9][a-z0-9-]{1,62}";
const NUM = "\\d{1,20}";
const ADDR = "qor1[02-9ac-hj-np-z]{38,90}";
const HASH = "[0-9A-Fa-f]{64}";

interface Rule { re: RegExp; ttlMs: number; query: string[] }

const rule = (path: string, ttlSec: number, query: string[] = []): Rule => ({
  re: new RegExp(`^${path}$`),
  ttlMs: ttlSec * 1000,
  query,
});

const PAGE = ["pagination.key", "pagination.limit", "pagination.reverse", "pagination.offset"];

export const RULES: Rule[] = [
  rule("/qorechain/rdk/v1/params", 300),
  rule("/qorechain/rdk/v1/rollups", 60, PAGE),
  rule(`/qorechain/rdk/v1/rollup/${ID}`, 15),
  rule(`/qorechain/rdk/v1/batch/${ID}/${NUM}`, 10),
  rule(`/qorechain/rdk/v1/batches/${ID}`, 10, ["start_index", "limit"]),
  rule(`/qorechain/rdk/v1/latest_batch/${ID}`, 5),
  rule(`/qorechain/rdk/v1/inbox/${ID}`, 5, ["inbox_end"]),
  rule(`/qorechain/rdk/v1/posted_data/${ID}/${NUM}`, 300),
  rule(`/qorechain/rdk/v1/submitter_bond/${ID}/${ADDR}`, 30),
  rule(`/qorechain/multilayer/v1/anchor/${ID}`, 5),
  rule(`/qorechain/multilayer/v1/anchors/${ID}`, 10, PAGE),
  rule("/qorechain/pqc/v1/params", 300),
  rule(`/qorechain/pqc/v1/account/${ADDR}`, 60),
  rule(`/qorechain/pqc/v1/kem/${ADDR}`, 60),
  rule(`/cosmos/tx/v1beta1/txs/${HASH}`, 600),
];

export interface Allowed { upstreamPath: string; ttlMs: number }

/** Returns the canonical upstream path (only allowed query keys, sorted) or undefined if the read is not allowed. */
export function allow(path: string, search: URLSearchParams): Allowed | undefined {
  const r = RULES.find((x) => x.re.test(path));
  if (!r) return undefined;
  const q = new URLSearchParams();
  for (const key of [...r.query].sort()) {
    const v = search.get(key);
    if (v !== null) {
      if (v.length > 200) return undefined;
      q.set(key, v);
    }
  }
  const qs = q.toString();
  return { upstreamPath: qs ? `${path}?${qs}` : path, ttlMs: r.ttlMs };
}
