import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  register74xxLibrary,
  LIBRARY_74XX,
} from "../library-74xx.js";
import { ComponentRegistry } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Manifest-hygiene tests — framework-layer generic contract
//
// Parametrised over each register*Library helper. Two invariants:
//
//   1. Disk-vs-array reconciliation:
//      - Every .dig file in the helper's source directory has exactly one
//        manifest entry referencing it.
//      - Every manifest entry's `file` exists on disk.
//
//   2. Manifest entry shape:
//      - Every entry has non-empty `name`, `description`, and `file` strings.
//      - `file` ends with `.dig`.
//
// These tests are the canonical destination for the 74xx-specific manifest
// completeness checks that were deleted from per-component test files.
//
// Adding a new register*Library helper? Add a row to LIBRARY_HELPERS below.
// ---------------------------------------------------------------------------

interface ManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly file: string;
}

interface LibraryHelperCase {
  readonly helperName: string;
  readonly sourceDir: string;
  readonly manifest: readonly ManifestEntry[];
  readonly register: (registry: ComponentRegistry) => void;
}

const LIBRARY_HELPERS: readonly LibraryHelperCase[] = [
  {
    helperName: "register74xxLibrary",
    sourceDir: "lib/74xx",
    manifest: LIBRARY_74XX,
    register: (registry) => register74xxLibrary(registry),
  },
];

describe.each(LIBRARY_HELPERS)(
  "library-manifest hygiene: $helperName",
  ({ sourceDir, manifest, register }) => {
    const absDir = join(process.cwd(), sourceDir);

    describe("manifest entry shape", () => {
      it("every entry has a non-empty name string", () => {
        for (const entry of manifest) {
          expect(typeof entry.name).toBe("string");
          expect(entry.name.length).toBeGreaterThan(0);
        }
      });

      it("every entry has a non-empty description string", () => {
        for (const entry of manifest) {
          expect(typeof entry.description).toBe("string");
          expect(entry.description.length).toBeGreaterThan(0);
        }
      });

      it("every entry has a non-empty file string ending with .dig", () => {
        for (const entry of manifest) {
          expect(typeof entry.file).toBe("string");
          expect(entry.file.length).toBeGreaterThan(0);
          expect(entry.file.endsWith(".dig")).toBe(true);
        }
      });
    });

    describe("disk-vs-manifest reconciliation", () => {
      it("every manifest entry's file exists on disk", () => {
        for (const entry of manifest) {
          const filePath = join(absDir, entry.file);
          expect(
            existsSync(filePath),
            `manifest entry "${entry.name}" references "${entry.file}" which does not exist at ${filePath}`,
          ).toBe(true);
        }
      });

      it("every .dig file on disk is referenced by exactly one manifest entry", () => {
        const diskFiles = readdirSync(absDir).filter((f) => f.endsWith(".dig"));
        for (const diskFile of diskFiles) {
          const matches = manifest.filter((e) => e.file === diskFile);
          expect(
            matches.length,
            `disk file "${diskFile}" is referenced by ${matches.length} manifest entries (expected exactly 1)`,
          ).toBe(1);
        }
      });

      it("manifest entry names are unique", () => {
        const names = manifest.map((e) => e.name);
        const unique = new Set(names);
        expect(unique.size).toBe(names.length);
      });

      it("manifest file references are unique", () => {
        const files = manifest.map((e) => e.file);
        const unique = new Set(files);
        expect(unique.size).toBe(files.length);
      });
    });

    describe("registration cross-check", () => {
      it("every manifest name is retrievable from the registry after registration", () => {
        const registry = new ComponentRegistry();
        register(registry);
        for (const entry of manifest) {
          expect(
            registry.getStandalone(entry.name),
            `manifest entry "${entry.name}" was not registered`,
          ).toBeDefined();
        }
      });
    });
  },
);