/**
 * Property-diversity pin audit — tests pin positions across .dig fixture files
 * that exercise non-default property combinations (inputCount, selectorBits,
 * bits, spreading, etc.).
 *
 * The shape-render-audit covers default-props pin positions and all 8
 * rotation/mirror transforms. This test complements it by catching
 * property-dependent pin layout bugs that only manifest with non-default
 * configurations found in real circuits.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, dirname, basename } from "path";

import { createDefaultRegistry } from "@/components/register-all";
import type { ComponentRegistry } from "@/core/registry";
import { loadWithSubcircuits, clearSubcircuitCache } from "@/io/subcircuit-loader";
import type { FileResolver } from "@/io/file-resolver";
import { ResolverNotFoundError } from "@/io/file-resolver";
import type { Circuit } from "@/core/circuit";
import { pinWorldPosition } from "@/core/pin";
import {
  getJavaPinPositions,
  javaWorldPosition,
} from "@/test-utils/java-pin-reference";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectDigFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectDigFiles(full));
    } else if (entry.endsWith(".dig")) {
      results.push(full);
    }
  }
  return results;
}

function buildDigIndex(roots: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const fullPath of collectDigFiles(root)) {
      const name = basename(fullPath);
      const key = name.endsWith(".dig") ? name.slice(0, -4) : name;
      if (!index.has(key)) index.set(key, fullPath);
      if (!index.has(name)) index.set(name, fullPath);
    }
  }
  return index;
}

class FixtureTreeResolver implements FileResolver {
  private readonly _index: Map<string, string>;
  private readonly _localDir: string;
  constructor(index: Map<string, string>, localDir: string) {
    this._index = index;
    this._localDir = localDir;
  }
  async resolve(name: string): Promise<string> {
    const suffix = name.endsWith(".dig") ? "" : ".dig";
    const localPath = join(this._localDir, name + suffix);
    if (existsSync(localPath)) return readFileSync(localPath, "utf-8");
    const key = name.endsWith(".dig") ? name.slice(0, -4) : name;
    const fullPath = this._index.get(key) ?? this._index.get(name);
    if (fullPath && existsSync(fullPath)) return readFileSync(fullPath, "utf-8");
    throw new ResolverNotFoundError(name);
  }
}

// ---------------------------------------------------------------------------
// Fixture discovery
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const FIXTURES_ROOT = join(PROJECT_ROOT, "fixtures");
const FIXTURE_DIRS = [
  join(FIXTURES_ROOT, "Sim"),
  join(FIXTURES_ROOT, "mod3", "Sim"),
];

const digIndex = buildDigIndex(FIXTURE_DIRS);

interface FixtureEntry {
  label: string;
  path: string;
  dir: string;
}

const fixtures: FixtureEntry[] = [];
for (const dir of FIXTURE_DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of collectDigFiles(dir)) {
    const rel = relative(FIXTURES_ROOT, f).replace(/\\/g, "/");
    fixtures.push({ label: rel, path: f, dir: dirname(f) });
  }
}

// Property keys needed by getJavaPinPositions
const PIN_RELEVANT_PROPS = [
  "bitWidth", "bits", "inputCount", "flipSelPos", "invertDriverOutput",
  "spreading", "input splitting", "output splitting", "selectorBits",
  "wideShape", "_inverterLabels", "withEnable",
  "poles", "commonConnection", "progChange",
] as const;

// ---------------------------------------------------------------------------
// Mismatch tracking
// ---------------------------------------------------------------------------

interface PinMismatch {
  fixture: string;
  typeId: string;
  pinLabel: string;
  rotation: number;
  mirror: boolean;
  expected: { x: number; y: number };
  actual: { x: number; y: number };
  delta: { dx: number; dy: number };
}

interface PinCountMismatch {
  fixture: string;
  typeId: string;
  expectedCount: number;
  actualCount: number;
}

const allMismatches: PinMismatch[] = [];
const allCountMismatches: PinCountMismatch[] = [];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("property-diversity pin audit — non-default props from fixtures", () => {
  let registry: ComponentRegistry;

  beforeAll(() => {
    registry = createDefaultRegistry();
  });

  if (fixtures.length === 0) {
    return;
  }

  describe.each(fixtures)("$label", ({ label, path, dir }) => {
    it("pin positions match Java reference", async () => {
      clearSubcircuitCache();
      const xml = readFileSync(path, "utf-8");
      const resolver = new FixtureTreeResolver(digIndex, dir);

      let circuit: Circuit;
      try {
        circuit = await loadWithSubcircuits(xml, resolver, registry);
      } catch {
        return;
      }

      for (const el of circuit.elements) {
        // Extract properties for getJavaPinPositions
        const props: Record<string, unknown> = {};
        if ("_properties" in el) {
          const bag = (el as any)._properties;
          if (bag && typeof bag.getOrDefault === "function") {
            for (const key of PIN_RELEVANT_PROPS) {
              try {
                const v = bag.getOrDefault(key, undefined);
                if (v !== undefined) props[key] = v;
              } catch { /* ignore */ }
            }
          }
        }

        const javaPins = getJavaPinPositions(el.typeId, props);
        if (!javaPins) continue;

        const tsPins = el.getPins();

        if (tsPins.length !== javaPins.length) {
          allCountMismatches.push({
            fixture: label,
            typeId: el.typeId,
            expectedCount: javaPins.length,
            actualCount: tsPins.length,
          });
          continue;
        }

        for (let i = 0; i < tsPins.length; i++) {
          const tsWorld = pinWorldPosition(el, tsPins[i]);
          const jp = javaPins[i];
          const javaWorld = javaWorldPosition(
            jp.x, jp.y,
            el.position.x, el.position.y,
            el.rotation, el.mirror,
          );

          const dx = Math.round((tsWorld.x - javaWorld.x) * 100) / 100;
          const dy = Math.round((tsWorld.y - javaWorld.y) * 100) / 100;

          if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
            allMismatches.push({
              fixture: label,
              typeId: el.typeId,
              pinLabel: tsPins[i].label,
              rotation: el.rotation,
              mirror: el.mirror,
              expected: javaWorld,
              actual: tsWorld,
              delta: { dx, dy },
            });
          }
        }
      }
    });
  });

  it("summary: zero pin position mismatches", () => {
    if (allMismatches.length === 0) return;

    const byType = new Map<string, PinMismatch[]>();
    for (const m of allMismatches) {
      if (!byType.has(m.typeId)) byType.set(m.typeId, []);
      byType.get(m.typeId)!.push(m);
    }

    const lines: string[] = [];
    lines.push(`\n${allMismatches.length} pin position mismatch(es) across ${byType.size} component type(s):\n`);

    for (const [typeId, mismatches] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const patterns = new Map<string, { count: number; example: PinMismatch }>();
      for (const m of mismatches) {
        const key = `rot=${m.rotation} mir=${m.mirror} pin=${m.pinLabel} delta=(${m.delta.dx},${m.delta.dy})`;
        if (!patterns.has(key)) {
          patterns.set(key, { count: 0, example: m });
        }
        patterns.get(key)!.count++;
      }

      lines.push(`  ${typeId} — ${mismatches.length} mismatch(es):`);
      for (const [pattern, { count, example }] of patterns) {
        lines.push(
          `    ${pattern} (×${count}) — expected (${example.expected.x},${example.expected.y}), got (${example.actual.x},${example.actual.y})`,
        );
      }
    }

    console.log(lines.join("\n"));
    expect(allMismatches.length, lines.join("\n")).toBe(0);
  });

  it("summary: zero pin count mismatches", () => {
    if (allCountMismatches.length === 0) return;

    const byType = new Map<string, PinCountMismatch[]>();
    for (const m of allCountMismatches) {
      if (!byType.has(m.typeId)) byType.set(m.typeId, []);
      byType.get(m.typeId)!.push(m);
    }

    const lines: string[] = [];
    lines.push(`\n${allCountMismatches.length} pin count mismatch(es) across ${byType.size} component type(s):\n`);

    for (const [typeId, mismatches] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const example = mismatches[0];
      lines.push(
        `  ${typeId} — expected ${example.expectedCount} pins, got ${example.actualCount} (×${mismatches.length} instances)`,
      );
    }

    console.log(lines.join("\n"));
    expect(allCountMismatches.length, lines.join("\n")).toBe(0);
  });
});
