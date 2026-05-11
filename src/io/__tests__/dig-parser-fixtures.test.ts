import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseDigXml } from "../dig-parser.js";

// ---------------------------------------------------------------------------
// Bundled-library parser smoke
//
// Generic contract: every .dig file under each bundled library directory must
// (a) parse without throwing, (b) yield a non-empty visualElements array, and
// (c) every visualElement carries a non-empty elementName string.
//
// Per-library element counts and per-component shape assertions belong in
// dedicated component or library-specific tests, not here. This file is the
// canonical destination for the parser-shape smoke tests.
//
// Adding a new bundled .dig library directory? Add a row to LIBRARY_DIRS.
// ---------------------------------------------------------------------------

interface LibraryDirCase {
  readonly label: string;
  readonly relativePath: string;
}

const ALL_LIBRARY_DIRS: readonly LibraryDirCase[] = [
  { label: "lib/74xx", relativePath: "lib/74xx" },
  { label: "lib/4xxx", relativePath: "lib/4xxx" },
];

const LIBRARY_DIRS: readonly LibraryDirCase[] = ALL_LIBRARY_DIRS.filter((c) =>
  existsSync(join(process.cwd(), c.relativePath)),
);

function listDigFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".dig"));
}

describe.each(LIBRARY_DIRS)(
  "parseDigXml smoke over bundled library: $label",
  ({ relativePath }) => {
    const dir = join(process.cwd(), relativePath);
    const files = listDigFiles(dir);

    it("library directory contains at least one .dig file", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)("%s parses without throwing", (file) => {
      const xml = readFileSync(join(dir, file), "utf-8");
      expect(() => parseDigXml(xml)).not.toThrow();
    });

    it.each(files)("%s yields a non-empty visualElements array", (file) => {
      const xml = readFileSync(join(dir, file), "utf-8");
      const circuit = parseDigXml(xml);
      expect(Array.isArray(circuit.visualElements)).toBe(true);
      expect(circuit.visualElements.length).toBeGreaterThan(0);
    });

    it.each(files)(
      "%s every visualElement has a non-empty elementName string",
      (file) => {
        const xml = readFileSync(join(dir, file), "utf-8");
        const circuit = parseDigXml(xml);
        for (const ve of circuit.visualElements) {
          expect(typeof ve.elementName).toBe("string");
          expect(ve.elementName.length).toBeGreaterThan(0);
        }
      },
    );
  },
);
