import { useEffect, useState } from "react";
import { NotFound } from "./api";

export interface DataState<T> { data?: T; error?: string; missing?: boolean; loading: boolean }

/** Loads once, then again every `refreshMs` (0 = never). Keeps the last good data if a refresh fails. */
export function useData<T>(load: () => Promise<T>, deps: unknown[], refreshMs = 0): DataState<T> {
  const [state, setState] = useState<DataState<T>>({ loading: true });
  useEffect(() => {
    let live = true;
    const run = () =>
      load().then(
        (data) => live && setState({ data, loading: false }),
        (e: Error) => live && setState((s) => ({ ...s, loading: false, missing: e instanceof NotFound, error: e.message })),
      );
    setState({ loading: true });
    run();
    const t = refreshMs ? setInterval(run, refreshMs) : undefined;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
