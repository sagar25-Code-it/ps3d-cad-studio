import { useCallback, useState } from "react";

function storage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/**
 * State that is remembered between visits in this browser (a per-viewer convenience: it is not part of the project and does not
 * travel with the file). A blocked or full localStorage just keeps the value in memory. `parse` turns stored text back into a value
 * and must tolerate garbage; `serialize` produces the text.
 */
export function usePersistedState<T>(key: string, fallback: T, parse: (text: string | null) => T, serialize: (value: T) => string): readonly [T, (value: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try { return parse(storage()?.getItem(key) ?? null); } catch { return fallback; }
  });
  const update = useCallback((next: T | ((current: T) => T)): void => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
      try { storage()?.setItem(key, serialize(resolved)); } catch { /* the value stays in memory */ }
      return resolved;
    });
  }, [key, serialize]);
  return [value, update];
}
