/**
 * Fixture audit — headless integrity checks for all .dig circuit fixtures.
 *
 * For each .dig file in fixtures/, loads the circuit (with recursive subcircuit
 * resolution across the full fixture tree) and runs structural checks:
 *
 *   1. Loads without throwing (only GenericInitCode may be skipped)
 *   2. Pin-wire connectivity: ZERO orphan wire endpoints allowed
 *   3. Bounding box containment: all draw-call geometry within declared bounds
 *   4. Text orientation: no upside-down text after rotation transforms
 *   5. Save/restore balance: every ctx.save() has a matching ctx.restore()
 *   6. No duplicate pin positions per element
 *   7. Every element draws without throwing
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
import { MockRenderContext } from "@/test-utils/mock-render-context";

// ---------------------------------------------------------------------------
// Only GenericInitCode is allowed to be skipped — it's a no-op metadata
// element with zero pins, zero outputs, no simulation behavior.
// ---------------------------------------------------------------------------

const ALLOWED_SKIP_ELEMENTS = new Set(["GenericInitCode"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all .dig files under a directory recursively. */
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

/** Position key (rounded to 0.01 to handle float noise). */
function ptKey(x: number, y: number): string {
  return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

/**
 * Build an index of all .dig files under a fixture root, keyed by basename.
 * When multiple files share a basename, the one closest to `preferDir` wins.
 *
 * This mirrors Java Digital's ElementLibrary behavior: subcircuit references
 * use bare filenames (e.g. "mcu_processor.dig"), and the library searches the
 * entire project tree to find them.
 */
function buildDigIndex(roots: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const fullPath of collectDigFiles(root)) {
      const name = basename(fullPath);
      // Strip .dig extension for lookup (resolver receives "name" or "name.dig")
      const key = name.endsWith(".dig") ? name.slice(0, -4) : name;
      // Also store with .dig extension
      if (!index.has(key)) index.set(key, fullPath);
      if (!index.has(name)) index.set(name, fullPath);
    }
  }
  return index;
}

/**
 * Resolver that searches the full fixture tree by basename.
 * This is how Java Digital works — subcircuit names are bare filenames,
 * resolved by scanning the library path.
 */
class FixtureTreeResolver implements FileResolver {
  private readonly _index: Map<string, string>;
  private readonly _localDir: string;

  constructor(index: Map<string, string>, localDir: string) {
    this._index = index;
    this._localDir = localDir;
  }

  async resolve(name: string): Promise<string> {
    // Try local directory first (same dir as parent circuit)
    const suffix = name.endsWith(".dig") ? "" : ".dig";
    const localPath = join(this._localDir, name + suffix);
    if (existsSync(localPath)) {
      return readFileSync(localPath, "utf-8");
    }

    // Fall back to global index (searches full fixture tree)
    const key = name.endsWith(".dig") ? name.slice(0, -4) : name;
    const fullPath = this._index.get(key) ?? this._index.get(name);
    if (fullPath && existsSync(fullPath)) {
      return readFileSync(fullPath, "utf-8");
    }

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

/** Global index of all .dig files in the fixture tree. */
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

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let registry: ComponentRegistry;

beforeAll(() => {
  registry = createDefaultRegistry();
});

// ---------------------------------------------------------------------------
// Intercept console.warn to detect unexpected skipped elements
// ---------------------------------------------------------------------------

function captureSkippedElements(fn: () => Promise<Circuit>): Promise<{ circuit: Circuit; skipped: string[] }> {
  const skipped: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = String(args[0] ?? "");
    const match = msg.match(/Skipping unregistered element "([^"]+)"/);
    if (match) {
      skipped.push(match[1]);
    }
    // Also catch unresolvable elements
    const match2 = msg.match(/Skipping unresolvable element "([^"]+)"/);
    if (match2) {
      skipped.push(match2[1]);
    }
  };

  return fn().then((circuit) => {
    console.warn = origWarn;
    return { circuit, skipped };
  }).catch((e) => {
    console.warn = origWarn;
    throw e;
  });
}

// ---------------------------------------------------------------------------
// Guard: require circuit to be loaded (fail, don't silently pass)
// ---------------------------------------------------------------------------

function requireCircuit(loadError: Error | null, circuit: Circuit | undefined): asserts circuit is Circuit {
  if (loadError) {
    throw new Error(`Prerequisite failed — circuit did not load: ${loadError.message}`);
  }
  if (!circuit) {
    throw new Error("Prerequisite failed — circuit is undefined");
  }
}

// ---------------------------------------------------------------------------
// Per-fixture test suite
// ---------------------------------------------------------------------------

describe("fixture audit", () => {
  if (fixtures.length === 0) {
    it.skip("no fixtures found", () => {});
    return;
  }

  describe.each(fixtures)("$label", ({ path, dir }) => {
    let circuit: Circuit;
    let skippedElements: string[] = [];
    let loadError: Error | null = null;

    beforeAll(async () => {
      clearSubcircuitCache();
      const xml = readFileSync(path, "utf-8");
      const resolver = new FixtureTreeResolver(digIndex, dir);

      try {
        const result = await captureSkippedElements(() =>
          loadWithSubcircuits(xml, resolver, registry),
        );
        circuit = result.circuit;
        skippedElements = result.skipped;
      } catch (e) {
        loadError = e as Error;
      }
    });

    // ------------------------------------------------------------------
    // 1. Loads without error, only GenericInitCode may be skipped
    // ------------------------------------------------------------------

    it("loads without error", () => {
      requireCircuit(loadError, circuit);
      expect(circuit.elements.length + circuit.wires.length).toBeGreaterThan(0);
    });

    it("no unexpected skipped elements", () => {
      requireCircuit(loadError, circuit);

      const unexpected = skippedElements.filter(
        (name) => !ALLOWED_SKIP_ELEMENTS.has(name),
      );
      if (unexpected.length > 0) {
        throw new Error(
          `Unexpected skipped elements: ${[...new Set(unexpected)].join(", ")}`,
        );
      }
    });

    // ------------------------------------------------------------------
    // 2. Pin-wire connectivity — ZERO orphans allowed
    // ------------------------------------------------------------------

    it("wire endpoints meet pins or junctions", () => {
      requireCircuit(loadError, circuit);

      // Build set of all pin world positions
      const pinPositions = new Set<string>();
      for (const el of circuit.elements) {
        for (const pin of el.getPins()) {
          const wp = pinWorldPosition(el, pin);
          pinPositions.add(ptKey(wp.x, wp.y));
        }
      }

      // Build wire endpoint counts for junction detection
      const wireEndpoints = new Map<string, number>();
      for (const wire of circuit.wires) {
        const sk = ptKey(wire.start.x, wire.start.y);
        const ek = ptKey(wire.end.x, wire.end.y);
        wireEndpoints.set(sk, (wireEndpoints.get(sk) ?? 0) + 1);
        wireEndpoints.set(ek, (wireEndpoints.get(ek) ?? 0) + 1);
      }

      // Every wire endpoint must touch a pin or another wire
      const orphans: string[] = [];
      for (const wire of circuit.wires) {
        for (const ep of [wire.start, wire.end]) {
          const key = ptKey(ep.x, ep.y);
          const touchesPin = pinPositions.has(key);
          const isJunction = (wireEndpoints.get(key) ?? 0) >= 2;
          if (!touchesPin && !isJunction) {
            orphans.push(`(${ep.x}, ${ep.y})`);
          }
        }
      }

      const unique = [...new Set(orphans)];
      if (unique.length > 0) {
        throw new Error(
          `${unique.length} orphan wire endpoint(s): ${unique.slice(0, 10).join(", ")}${unique.length > 10 ? ` ...+${unique.length - 10} more` : ""}`,
        );
      }
    });

    // ------------------------------------------------------------------
    // 3. Every element draws without throwing
    // ------------------------------------------------------------------

    it("all elements draw without error", () => {
      requireCircuit(loadError, circuit);

      const failures: string[] = [];
      for (const el of circuit.elements) {
        const ctx = new MockRenderContext();
        try {
          el.draw(ctx);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          failures.push(`[${el.typeId}] @ (${el.position.x},${el.position.y}): ${msg}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} element(s) threw on draw():\n${failures.join("\n")}`,
        );
      }
    });

    // ------------------------------------------------------------------
    // 4. Bounding box containment
    // ------------------------------------------------------------------

    it("draw calls within bounding box", () => {
      requireCircuit(loadError, circuit);

      const MARGIN = 1.5;
      const violations: string[] = [];

      for (const el of circuit.elements) {
        const bb = el.getBoundingBox();
        const localBB = {
          x: bb.x - el.position.x,
          y: bb.y - el.position.y,
          width: bb.width,
          height: bb.height,
        };
        const ctx = new MockRenderContext();
        el.draw(ctx);

        for (const call of ctx.calls) {
          if (call.kind === "rect") {
            if (call.x < localBB.x - MARGIN ||
                call.y < localBB.y - MARGIN ||
                call.x + call.width > localBB.x + localBB.width + MARGIN ||
                call.y + call.height > localBB.y + localBB.height + MARGIN) {
              violations.push(
                `[${el.typeId}] rect(${call.x},${call.y},${call.width},${call.height}) outside bbox(${localBB.x},${localBB.y},${localBB.width},${localBB.height})`,
              );
            }
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `${violations.length} bounding box violation(s):\n${violations.slice(0, 10).join("\n")}`,
        );
      }
    });

    // ------------------------------------------------------------------
    // 5. Text orientation: no upside-down text
    // ------------------------------------------------------------------

    it("no upside-down text", () => {
      requireCircuit(loadError, circuit);

      for (const el of circuit.elements) {
        const ctx = new MockRenderContext();
        el.draw(ctx);

        const externalRotation = (el.rotation * Math.PI) / 2;
        let currentRotation = externalRotation;
        const rotationStack: number[] = [];

        for (const call of ctx.calls) {
          switch (call.kind) {
            case "save":
              rotationStack.push(currentRotation);
              break;
            case "restore":
              currentRotation = rotationStack.pop() ?? externalRotation;
              break;
            case "rotate":
              currentRotation += call.angle;
              break;
            case "text": {
              const norm =
                ((currentRotation % (2 * Math.PI)) + 2 * Math.PI) %
                (2 * Math.PI);
              const isUpsideDown = Math.abs(norm - Math.PI) < 0.1;
              if (isUpsideDown) {
                throw new Error(
                  `[${el.typeId}] upside-down text "${call.text}" — net rotation ${(norm * 180 / Math.PI).toFixed(0)}° (element rotation=${el.rotation})`,
                );
              }
              break;
            }
          }
        }
      }
    });

    // ------------------------------------------------------------------
    // 6. Save/restore balance
    // ------------------------------------------------------------------

    it("save/restore balanced", () => {
      requireCircuit(loadError, circuit);

      const imbalanced: string[] = [];
      for (const el of circuit.elements) {
        const ctx = new MockRenderContext();
        el.draw(ctx);

        const saves = ctx.callsOfKind("save").length;
        const restores = ctx.callsOfKind("restore").length;
        if (saves !== restores) {
          imbalanced.push(
            `[${el.typeId}] @ (${el.position.x},${el.position.y}): ${saves} saves vs ${restores} restores`,
          );
        }
      }

      if (imbalanced.length > 0) {
        throw new Error(
          `${imbalanced.length} element(s) with imbalanced save/restore:\n${imbalanced.join("\n")}`,
        );
      }
    });

    // ------------------------------------------------------------------
    // 7. Pin positions are unique per element
    // ------------------------------------------------------------------

    it("no duplicate pin positions", () => {
      requireCircuit(loadError, circuit);

      for (const el of circuit.elements) {
        const pins = el.getPins();
        const seen = new Set<string>();
        for (const pin of pins) {
          const wp = pinWorldPosition(el, pin);
          const key = ptKey(wp.x, wp.y);
          if (seen.has(key)) {
            throw new Error(
              `[${el.typeId}] duplicate pin at (${wp.x}, ${wp.y}): "${pin.label}"`,
            );
          }
          seen.add(key);
        }
      }
    });
  });
});
