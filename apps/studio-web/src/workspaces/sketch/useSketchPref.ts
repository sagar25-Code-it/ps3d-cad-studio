import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { sketchPrefs } from "./sketch-prefs.js";

/**
 * `useState` whose value survives the Sketch workspace being unmounted (a switch to Part and back). Set `durable: false` for values
 * that hold ids of sketch geometry: they last for the session but are not written to localStorage.
 */
export function useSketchPref<T>(key: string, initial: T, options: { readonly durable?: boolean } = {}): [T, Dispatch<SetStateAction<T>>] {
  const durable = options.durable ?? true;
  const [value, setValue] = useState<T>(() => sketchPrefs.get(key, initial, durable));
  useEffect(() => {
    sketchPrefs.set(key, value, durable);
  }, [key, value, durable]);
  return [value, setValue];
}
