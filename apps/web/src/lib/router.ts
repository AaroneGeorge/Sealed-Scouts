import { useEffect, useState } from "react";

export interface Route { page: "rounds" | "round" | "verify" | "attacks" | "lender"; param?: string; query: URLSearchParams }

/** Hash routes, so the page works from any static host and needs no server rewrites. */
export function parseRoute(hash: string): Route {
  const [path = "", qs = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const query = new URLSearchParams(qs);
  if (parts[0] === "round" && parts[1]) return { page: "round", param: parts[1], query };
  if (parts[0] === "verify" || parts[0] === "attacks" || parts[0] === "lender") return { page: parts[0], query };
  return { page: "rounds", query };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo({ top: 0 });
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
