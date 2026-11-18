import { useEffect, useState } from "react";
import { Empty } from "./components/bits";
import { Seal } from "./components/Seal";
import { api } from "./lib/api";
import { useRoute } from "./lib/router";
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

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    (localStorage.getItem("theme") as "dark" | "light" | null) ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  return [theme, () => setTheme(theme === "dark" ? "light" : "dark")] as const;
}

export function App() {
  const route = useRoute();
  const [theme, toggleTheme] = useTheme();
  const status = useData(api.status, [], 10_000);
  const deployments = useData(api.deployments, []);
  const rollupId = status.data?.rollupId ?? deployments.data?.rollupId ?? DEFAULT_ROLLUP;
  const { priceFeed, scoutLend } = contractsOf(deployments.data);
  const current = route.page === "round" ? "rounds" : route.page;

  return (
    <>
      <header className="top">
        <div className="wrap top-row">
          <a href="#/" className="brand"><Seal size={30} /> Sealed Scouts <small>testnet</small></a>
          <nav className="nav">
            {NAV.map((n) => <a key={n.page} href={n.href} aria-current={current === n.page ? "page" : undefined}>{n.label}</a>)}
          </nav>
          <button className="icon-btn" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>
      <div className="wrap">
        {isSample(status.data) && (
          <div className="banner">
            Sample data: a simulated history replayed by the real watchtower code. The live feed replaces it once the rollup
            runs. The Verify tab always reads the real chain.
          </div>
        )}
        <main>
          {route.page === "rounds" && (status.data ? <Rounds status={status.data} /> :
            <Empty>{status.loading ? "Loading the feed…" : status.missing ? "The watchtower has not published a feed yet." : `Feed unavailable: ${status.error}`}</Empty>)}
          {route.page === "round" && <Round id={route.param!} rollupId={rollupId} priceFeed={priceFeed} />}
          {route.page === "verify" && <Verify defaultRollup={deployments.data?.rollupId ?? DEFAULT_ROLLUP} query={route.query} />}
          {route.page === "attacks" && <Attacks />}
          {route.page === "lender" && <Lender priceFeed={priceFeed} scoutLend={scoutLend} />}
        </main>
      </div>
      <footer>
        <div className="wrap row">
          <span>QoreChain testnet <code>qorechain-diana</code> · EVM 9800 · rollup <code>{rollupId}</code></span>
          <span><a href={REPO_URL}>Source</a> · Apache-2.0</span>
        </div>
      </footer>
    </>
  );
}
