import { useEffect, useState } from "react";

export interface Route {
  page: "rounds" | "round" | "verify" | "attacks" | "lender";
  param?: string;
  query: URLSearchParams;
  /** An element id after a second "#" (as in #/attacks#bad-batch): the page scrolls to it once it is drawn. */
  anchor?: string;
}

/** Hash routes, so the page works from any static host and needs no server rewrites. */
export function parseRoute(hash: string): Route {
  const [route = "", anchor] = hash.replace(/^#/, "").split("#");
  const [path = "", qs = ""] = route.split("?");
  const parts = path.split("/").filter(Boolean);
  const query = new URLSearchParams(qs);
  const at = anchor && /^[a-z0-9-]+$/i.test(anchor) ? { anchor } : {};
  if (parts[0] === "round" && parts[1]) return { page: "round", param: parts[1], query, ...at };
  if (parts[0] === "verify" || parts[0] === "attacks" || parts[0] === "lender") return { page: parts[0], query, ...at };
  return { page: "rounds", query, ...at };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      const next = parseRoute(location.hash);
      setRoute(next);
      // A route with an anchor is scrolled by its page (useAnchor), once the element exists.
      if (!next.anchor) window.scrollTo({ top: 0 });
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Scrolls to the route's anchor once `ready` (the page's data has loaded and the element is drawn). */
export function useAnchor(anchor: string | undefined, ready: boolean) {
  useEffect(() => {
    if (!anchor || !ready) return;
    const el = document.getElementById(anchor);
    if (el) el.scrollIntoView({ block: "start" });
  }, [anchor, ready]);
}
