import { useEffect, useState } from "react";
import { Empty, useFresh } from "./components/bits";
import { Seal } from "./components/Seal";
import { api } from "./lib/api";
import { dateline, feedState, formatAge, formatChange, tickerOf, type TickerItem } from "./lib/edition";
import { formatPrice } from "./lib/format";
import { useRoute } from "./lib/router";
import type { TowerStatus } from "./lib/types";
import { useData } from "./lib/useData";
import { contractsOf, isSample } from "./lib/view";
import { Attacks } from "./pages/Attacks";
import { Lender } from "./pages/Lender";
import { Round } from "./pages/Round";
import { Rounds } from "./pages/Rounds";
import { Verify } from "./pages/Verify";

const DEFAULT_ROLLUP = "sealed-scouts-1";
const REPO_URL = "https://github.com/AaroneGeorge/Sealed-Scouts";

const NAV = [
  { href: "#/", page: "rounds", label: "Rounds" },
  { href: "#/verify", page: "verify", label: "Verify" },
  { href: "#/attacks", page: "attacks", label: "Attacks" },
  { href: "#/lender", page: "lender", label: "Lender" },
] as const;

type Theme = "dark" | "light";

/** theme.js picks the edition before first paint; the toggle changes it and remembers the reader's choice. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, toggle] as const;
}

export function App() {
  const route = useRoute();
  const [theme, toggleTheme] = useTheme();
  const status = useData(api.status, [], 10_000);
  const deployments = useData(api.deployments, []);
  const rollupId = status.data?.rollupId ?? deployments.data?.rollupId ?? DEFAULT_ROLLUP;
  const { priceFeed, scoutLend } = contractsOf(deployments.data);
  const current = route.page === "round" ? "rounds" : route.page;
  const sample = isSample(status.data);

  return (
    <>
      <header className="masthead">
        <div className="page">
          <div className="mast-top">
            <span>A post-quantum price oracle on QoreChain</span>
            {/* The visible label is the accessible name: it says which edition (and theme) the button switches to. */}
            <button className="theme" onClick={toggleTheme}>
              {theme === "dark" ? "Day edition (light)" : "Evening edition (dark)"} <span aria-hidden="true">→</span>
            </button>
          </div>
          <Nameplate status={status.data} sample={sample} rollupId={rollupId} />
          <Dateline status={status.data} loading={status.loading} sample={sample} />
          <nav className="sections" aria-label="Sections">
            {NAV.map((n) => <a key={n.page} href={n.href} aria-current={current === n.page ? "page" : undefined}>{n.label}</a>)}
          </nav>
        </div>
        {status.data && <Ticker status={status.data} />}
      </header>
      <div className="page">
        {sample && (
          <div className="banner" role="note">
            <b>Sample data</b>
            A simulated history replayed by the real watchtower code. The live feed replaces it once the rollup runs. The
            Verify tab always reads the real chain.
          </div>
        )}
        <main>
          {route.page === "rounds" && (status.data ? <Rounds status={status.data} roundMode={deployments.data?.roundMode} /> :
            <Empty>{status.loading ? "Loading the feed…" : status.missing ? "The watchtower has not published a feed yet." : `Feed unavailable: ${status.error}`}</Empty>)}
          {route.page === "round" && <Round id={route.param!} rollupId={rollupId} priceFeed={priceFeed} mode={status.data?.mode} />}
          {route.page === "verify" && <Verify defaultRollup={deployments.data?.rollupId ?? DEFAULT_ROLLUP} query={route.query} />}
          {route.page === "attacks" && <Attacks />}
          {route.page === "lender" && <Lender priceFeed={priceFeed} scoutLend={scoutLend} />}
        </main>
      </div>
      <footer>
        <div className="page">
          <span>QoreChain testnet <code>qorechain-diana</code> · EVM chain 9800 · rollup <code>{rollupId}</code></span>
          <span>Prices, heights and hashes come from the chain or the watchtower's feed. <a href={REPO_URL}>Source</a> · Apache-2.0</span>
        </div>
      </footer>
    </>
  );
}

function Nameplate({ status, sample, rollupId }: { status?: TowerStatus; sample: boolean; rollupId: string }) {
  const latest = status?.rounds.latest;
  const now = useNow();
  const feed = status ? feedState(status.updatedAt, now) : undefined;
  return (
    <div className="nameplate-row">
      <div className="ear">
        <b>{latest ? `Round ${latest} edition` : "Edition pending"}</b>
        Rollup {rollupId}
      </div>
      <a href="#/" className="nameplate" aria-label="Sealed Scouts, front page">Sealed <Seal size={48} /> Scouts</a>
      <div className="ear ear-r">
        {!status ? <><b>Feed not loaded</b>Watchtower status unknown</>
          : sample ? <><b className="state-sample">Sample edition</b>Simulated history, not chain data</>
          : feed?.paused ? <><b className="state-sample">Feed paused</b>No update for {formatAge(feed.ageMs)}</>
          : <><b>Live testnet feed</b>qorechain-diana · watchtower in {status.mode} mode</>}
      </div>
    </div>
  );
}

function Dateline({ status, loading, sample }: { status?: TowerStatus; loading: boolean; sample: boolean }) {
  const now = useNow();
  const d = status ? dateline(status.updatedAt) : undefined;
  const paused = status && !sample && feedState(status.updatedAt, now).paused;
  return (
    <div className="dateline">
      <span>{d?.date || (loading ? "Loading the edition…" : "Date unknown")}</span>
      {status && (
        <span>
          {paused ? <b className="bad">Feed paused: last update {d?.time}</b> : sample ? `Sample feed written ${d?.time}` : `Feed updated ${d?.time}`}
          {" "}· replayed to height {BigInt(status.chainHeight).toLocaleString("en-US")}
        </span>
      )}
    </div>
  );
}

/** The reader's clock, ticking every 30 seconds, so "paused" appears even when no new data arrives. */
function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function Ticker({ status }: { status: TowerStatus }) {
  const items = tickerOf(status);
  return (
    <div className="ticker" aria-label="Latest verified prices">
      <div className="page">
        <span className="lbl">Latest verified</span>
        {items.length === 0 ? <span className="note">No round is final with a replay that agrees yet.</span> : (
          <>
            {items.map((t) => <TickerEntry key={t.feedId} t={t} />)}
            <span className="note">Round {items[0]!.round}, {items[0]!.status}{items[0]!.prevRound ? `; change from round ${items[0]!.prevRound}` : ""}</span>
          </>
        )}
      </div>
    </div>
  );
}

function TickerEntry({ t }: { t: TickerItem }) {
  const fresh = useFresh(t.price);
  const chg = formatChange(t.changeBps);
  const dir = t.changeBps ? (t.changeBps > 0 ? "up" : "dn") : "";
  return (
    <span className={`item ${fresh ? "fresh" : ""}`}>
      <span className="sym">{t.symbol}</span>
      <span className="fig">{formatPrice(t.price)}</span>
      {chg && <span className={`chg fig ${dir}`}>{dir === "up" ? "▲ " : dir === "dn" ? "▼ " : ""}{chg}</span>}
    </span>
  );
}
