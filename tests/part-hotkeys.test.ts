import { PART_HOTKEYS, partHotkeyCommand } from "../apps/studio-web/src/part-hotkeys.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-10: the Part letters a Fusion user expects. One table drives the listener, so these checks hold for the app:
 * E Extrude, Q Press Pull, F Fillet, H Hole, M Move, I Measure, A Appearance in the Part workspace; Fit on F6
 * everywhere in 3D; and outside the Part workspace the letters stand aside so F stays Fit and M stays Measure there.
 */
export const partHotkeyTests: readonly TestCase[] = [
  {
    name: "The Part hotkey table binds each Fusion letter exactly once and routes Part-only letters nowhere else",
    run: () => {
      const keys = PART_HOTKEYS.map((entry) => entry.key);
      assert(new Set(keys).size === keys.length, `no key is bound twice: ${keys.join(", ")}`);
      const expect = (key: string, workspace: string, command: string | undefined): void => {
        const found = partHotkeyCommand(key, workspace);
        assert(found === command, `${key} in ${workspace} -> ${String(command)} (got ${String(found)})`);
      };
      expect("e", "part", "extrude");
      expect("E", "part", "extrude");
      expect("q", "part", "press-pull");
      expect("f", "part", "fillet");
      expect("h", "part", "hole");
      expect("m", "part", "move");
      expect("i", "part", "measure");
      expect("a", "part", "appearance");
      expect("f6", "part", "fit");
      expect("s", "part", undefined); // S stays the command search, handled by its own listener
      // Outside the Part workspace the modelling letters stand aside (the listener keeps F = Fit, M = Measure there).
      expect("e", "assembly", undefined);
      expect("f", "assembly", undefined);
      expect("h", "surface", undefined);
      expect("m", "vehicle", undefined);
      expect("f6", "assembly", "fit");
      expect("i", "assembly", "measure");
      expect("1", "assembly", "view-front");
      expect("v", "part", "nav-select");
    }
  }
];
