/**
 * Shape audit — systematic comparison of TS pin positions against Java Digital's
 * expected pin positions for every component type found in fixtures.
 *
 * For each element in each .dig fixture:
 *   1. Computes pin world positions using our TS code (pinWorldPosition)
 *   2. Computes expected pin world positions using Java's transform rules
 *      applied to the Java-reference local pin positions
 *   3. Reports per-component-type mismatches with deltas
 *
 * This catches:
 *   - Wrong pin offsets (shape geometry bugs)
 *   - Wrong rotation transforms
 *   - Wrong mirror transforms
 *   - Wrong bounding box / shape sizing
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
import type { Rotation } from "@/core/pin";

// ---------------------------------------------------------------------------
// Helpers (shared with fixture-audit)
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

function ptKey(x: number, y: number): string {
  return `${Math.round(x * 100)},${Math.round(y * 100)}`;
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
// Java-reference pin positions per component type (in grid units, SIZE=1)
//
// Extracted from ref/Digital/src/main/java/.../shapes/*.java getPins().
// Positions are LOCAL (before rotation/mirror/translate).
// ---------------------------------------------------------------------------

interface JavaPinRef {
  label: string;
  x: number;
  y: number;
}

/**
 * Count ports in a Splitter split definition string.
 * Handles "bits", "bits*count", and "from-to" notation.
 */
function countSplitPorts(definition: string): number {
  if (!definition || definition.length === 0) return 1;
  let count = 0;
  for (const token of definition.split(",").map(s => s.trim()).filter(s => s.length > 0)) {
    const starIdx = token.indexOf("*");
    if (starIdx >= 0) {
      count += parseInt(token.substring(starIdx + 1).trim(), 10) || 1;
    } else {
      count++;
    }
  }
  return count || 1;
}

/**
 * Compute Java GenericShape pin positions for gate-like components.
 *
 * Java GenericShape.createPins() formula (all values in grid units, SIZE=1):
 *   symmetric = (outputCount == 1)
 *   offs = symmetric ? floor(inputCount/2) : 0
 *   Input i: (dx, i + correct)
 *     correct = 1 if symmetric && even input count && i >= inputCount/2
 *     dx = -1 if input label is in inverterConfig, else 0
 *   Output i: (width + (invert?1:0), i + offs)
 */
function buildGenericShapePins(
  inputCount: number,
  outputCount: number,
  width: number,
  invert: boolean,
  invertedLabels: ReadonlySet<string>,
  inputLabels?: readonly string[],
): JavaPinRef[] {
  const symmetric = outputCount === 1;
  const even = inputCount > 0 && (inputCount & 1) === 0;
  const offs = symmetric ? Math.floor(inputCount / 2) : 0;

  const pins: JavaPinRef[] = [];

  for (let i = 0; i < inputCount; i++) {
    const correct = (symmetric && even && i >= inputCount / 2) ? 1 : 0;
    const label = inputLabels?.[i] ?? `In_${i + 1}`;
    const dx = invertedLabels.has(label) ? -1 : 0;
    pins.push({ label, x: dx, y: i + correct });
  }

  const outX = invert ? width + 1 : width;
  for (let i = 0; i < outputCount; i++) {
    pins.push({ label: "out", x: outX, y: i + offs });
  }

  return pins;
}

/**
 * Returns the Java-reference local pin positions for a given element type
 * and its attributes. Returns null if the type is unknown (subcircuit, etc.).
 */
function getJavaPinPositions(
  typeId: string,
  props: Record<string, unknown>,
): JavaPinRef[] | null {
  const bits = (props["bitWidth"] as number) ?? 1;
  const inputCount = (props["inputCount"] as number) ?? 2;
  const flip = !!(props["flipSelPos"] ?? false);
  const wide = !!(props["wideShape"] ?? false);

  // Parse inverter config labels
  const invertedLabels = new Set<string>();
  const invCfg = props["_inverterLabels"] as string | undefined;
  if (invCfg && invCfg.length > 0) {
    for (const s of invCfg.split(",")) invertedLabels.add(s.trim());
  }

  switch (typeId) {
    // --- Simple I/O: single pin at origin ---
    case "Probe":
    case "Tunnel":
    case "Clock":
    case "Button":
    case "Const":
    case "Ground":
    case "VDD":
    case "PullUp":
    case "PullDown":
    case "Reset":
    case "Break":
    case "DipSwitch":
    case "LED":
    case "In":
    case "Out":
    case "NotConnected":
      return [{ label: "pin", x: 0, y: 0 }];

    // --- Driver (tri-state buffer) ---
    // Java: input at (-SIZE,0), sel at (0, ±SIZE), output at (SIZE,0) or (SIZE*2,0)
    case "Driver":
    case "DriverInvSel": {
      const invertOut = !!(props["invertDriverOutput"] ?? false);
      return [
        { label: "in", x: -1, y: 0 },
        { label: "sel", x: 0, y: flip ? 1 : -1 },
        { label: "out", x: invertOut ? 2 : 1, y: 0 },
      ];
    }

    // --- Splitter ---
    // Java: inputs at (0, i*spreading), outputs at (SIZE, i*spreading)
    // Split strings use "bits", "bits*count", or "from-to" notation.
    case "Splitter": {
      const spreading = (props["spreading"] as number) ?? 1;
      const inputSplit = (props["input splitting"] as string) ?? "4,4";
      const outputSplit = (props["output splitting"] as string) ?? "8";
      const inCount = countSplitPorts(inputSplit);
      const outCount = countSplitPorts(outputSplit);
      const pins: JavaPinRef[] = [];
      for (let i = 0; i < inCount; i++) {
        pins.push({ label: `in_${i}`, x: 0, y: i * spreading });
      }
      for (let i = 0; i < outCount; i++) {
        pins.push({ label: `out_${i}`, x: 1, y: i * spreading });
      }
      return pins;
    }

    // --- Delay ---
    case "Delay":
      return [
        { label: "in", x: 0, y: 0 },
        { label: "out", x: 2, y: 0 },
      ];

    // --- BitSelector ---
    case "BitSel": {
      return [
        { label: "in", x: 0, y: 0 },
        { label: "sel", x: 1, y: flip ? -1 : 1 },
        { label: "out", x: 2, y: 0 },
      ];
    }

    // --- Multiplexer ---
    case "Multiplexer": {
      const selBits = (props["selectorBits"] as number) ?? 1;
      const muxInputCount = 1 << selBits;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "sel", x: 1, y: flip ? 0 : muxInputCount });
      if (muxInputCount === 2) {
        pins.push({ label: "in_0", x: 0, y: 0 });
        pins.push({ label: "in_1", x: 0, y: 2 });
      } else {
        for (let i = 0; i < muxInputCount; i++) {
          pins.push({ label: `in_${i}`, x: 0, y: i });
        }
      }
      pins.push({ label: "out", x: 2, y: Math.floor(muxInputCount / 2) });
      return pins;
    }

    // --- Demultiplexer ---
    // Java: height = outputCount (when hasInput, which is always true for us)
    // Pin order: sel, outputs, then input LAST
    case "Demultiplexer": {
      const selBits = (props["selectorBits"] as number) ?? 1;
      const outCount = 1 << selBits;
      const height = outCount; // Java: hasInput → outputCount * SIZE
      const pins: JavaPinRef[] = [];
      pins.push({ label: "sel", x: 1, y: flip ? 0 : height });
      if (outCount === 2) {
        pins.push({ label: "out_0", x: 2, y: 0 });
        pins.push({ label: "out_1", x: 2, y: 2 });
      } else {
        for (let i = 0; i < outCount; i++) {
          pins.push({ label: `out_${i}`, x: 2, y: i });
        }
      }
      pins.push({ label: "in", x: 0, y: Math.floor(outCount / 2) });
      return pins;
    }

    // --- Diodes ---
    case "Diode":
      return [
        { label: "out1", x: 0, y: 0 },
        { label: "out2", x: 0, y: -1 },
      ];
    case "DiodeBackward":
      return [
        { label: "in", x: 0, y: 0 },
        { label: "out", x: 0, y: -1 },
      ];
    case "DiodeForeward":
      return [
        { label: "in", x: 0, y: 0 },
        { label: "out", x: 0, y: 1 },
      ];

    // --- FETs ---
    case "NFET":
    case "FGNFET":
      return [
        { label: "Gate", x: 0, y: 2 },
        { label: "Drain", x: 1, y: 0 },
        { label: "Source", x: 1, y: 2 },
      ];
    // --- PFET/FGPFET ---
    // Java FETShapeP: Gate at (0,0), Drain at (SIZE,0)=(1,0), Source at (SIZE,SIZE*2)=(1,2)
    // TS pin labels: G, S, D (matching the TS component, not Java's output naming)
    case "PFET":
    case "FGPFET":
      return [
        { label: "G", x: 0, y: 0 },
        { label: "S", x: 1, y: 0 },
        { label: "D", x: 1, y: 2 },
      ];

    // --- TransGate ---
    case "TransGate":
      return [
        { label: "p1", x: 1, y: -1 },
        { label: "p2", x: 1, y: 1 },
        { label: "out1", x: 0, y: 0 },
        { label: "out2", x: 2, y: 0 },
      ];

    // --- Rotary encoder ---
    case "RotEncoder":
      return [
        { label: "A", x: 0, y: 0 },
        { label: "B", x: 0, y: 1 },
      ];

    // --- ButtonLED ---
    case "ButtonLED":
      return [
        { label: "out", x: 0, y: 0 },
        { label: "in", x: 0, y: 1 },
      ];

    // --- LightBulb ---
    case "LightBulb":
      return [
        { label: "A", x: 0, y: 0 },
        { label: "B", x: 0, y: 2 },
      ];

    // --- PolarityAwareLED ---
    case "PolarityAwareLED":
      return [
        { label: "A", x: 0, y: 0 },
        { label: "K", x: 0, y: 4 },
      ];

    // --- RGB LED ---
    case "RGBLED":
      return [
        { label: "R", x: 0, y: -1 },
        { label: "G", x: 0, y: 0 },
        { label: "B", x: 0, y: 1 },
      ];

    // --- Fuse ---
    case "Fuse":
      return [
        { label: "out1", x: 0, y: 0 },
        { label: "out2", x: 1, y: 0 },
      ];

    // --- Scope ---
    case "Scope":
      return [{ label: "clk", x: 0, y: 0 }];

    // --- GenericShape gates (non-inverted output) ---
    case "And":
    case "Or":
    case "XOr": {
      const n = inputCount;
      const w = (n === 1 && !wide ? 1 : 3) + (wide ? 1 : 0);
      return buildGenericShapePins(n, 1, w, false, invertedLabels);
    }

    // --- GenericShape gates (inverted output) ---
    case "NAnd":
    case "NOr":
    case "XNOr": {
      const n = inputCount;
      const w = (n === 1 && !wide ? 1 : 3) + (wide ? 1 : 0);
      return buildGenericShapePins(n, 1, w, true, invertedLabels);
    }

    // --- NOT (single input, inverted output, base width=1) ---
    case "Not": {
      const w = 1 + (wide ? 1 : 0);
      return buildGenericShapePins(1, 1, w, true, invertedLabels);
    }

    // --- Neg (single input/output, width=3, no inversion bubble) ---
    case "Neg":
      return buildGenericShapePins(1, 1, 3, false, invertedLabels);

    // ===================================================================
    // Flip-flops — GenericShape, width=3, showPinLabels=true
    // Non-symmetric (2 outputs), so no even-gap correction on outputs.
    // ===================================================================

    case "D_FF":
      // Inputs: D, C; Outputs: Q, ~Q
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, ["D", "C"]);

    case "JK_FF":
      // Inputs: J, C, K; Outputs: Q, ~Q
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, ["J", "C", "K"]);

    case "RS_FF":
      // Inputs: S, C, R; Outputs: Q, ~Q
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, ["S", "C", "R"]);

    case "T_FF": {
      // With enable: T, C; Without: C only — Java default is true
      const withEnable = !!(props["withEnable"] ?? true);
      return buildGenericShapePins(withEnable ? 2 : 1, 2, 3, false, invertedLabels,
        withEnable ? ["T", "C"] : ["C"]);
    }

    case "D_FF_AS":
      // Inputs: Set, D, C, Clr; Outputs: Q, ~Q
      return buildGenericShapePins(4, 2, 3, false, invertedLabels, ["Set", "D", "C", "Clr"]);

    case "JK_FF_AS":
      // Inputs: Set, J, C, K, Clr; Outputs: Q, ~Q
      return buildGenericShapePins(5, 2, 3, false, invertedLabels, ["Set", "J", "C", "K", "Clr"]);

    case "RS_FF_AS":
      // Inputs: S, R; Outputs: Q, ~Q (fully async, no clock)
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, ["S", "R"]);

    case "Monoflop":
      // Inputs: C, ~Q; Outputs: Q, ~Q
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, ["C", "~Q"]);

    // ===================================================================
    // Arithmetic — GenericShape, width=3
    // ===================================================================

    case "Add":
    case "Sub":
      // Inputs: a, b, c_i; Outputs: s, c_o
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, ["a", "b", "c_i"]);

    case "Comparator":
      // Inputs: a, b; Outputs: >, =, <
      return buildGenericShapePins(2, 3, 3, false, invertedLabels, ["a", "b"]);

    case "Mul":
      // Inputs: a, b; Output: mul (Java: width=3, showPinLabels=true)
      return buildGenericShapePins(2, 1, 3, false, invertedLabels, ["a", "b"]);

    // ===================================================================
    // Memory — GenericShape, width=3
    // ===================================================================

    case "Register":
      // Inputs: D, C, en; Output: Q (symmetric, offs=1)
      return buildGenericShapePins(3, 1, 3, false, invertedLabels, ["D", "C", "en"]);

    case "Counter":
      // Inputs: en, C, clr; Outputs: out, ovf
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, ["en", "C", "clr"]);

    case "CounterPreset":
      // Inputs: en, C, dir, in, ld, clr; Outputs: out, ovf
      return buildGenericShapePins(6, 2, 3, false, invertedLabels, ["en", "C", "dir", "in", "ld", "clr"]);

    case "ROM":
      // Inputs: A, sel; Output: D (symmetric, offs=1)
      return buildGenericShapePins(2, 1, 3, false, invertedLabels, ["A", "sel"]);

    case "RAMSinglePort":
      // Inputs: A, str, C, ld; Output: D (symmetric, offs=2)
      return buildGenericShapePins(4, 1, 3, false, invertedLabels, ["A", "str", "C", "ld"]);

    case "RAMDualPort":
      // Inputs: A, Din, str, C, ld; Output: D (symmetric, offs=2)
      return buildGenericShapePins(5, 1, 3, false, invertedLabels, ["A", "Din", "str", "C", "ld"]);

    case "EEPROM":
      // Inputs: A, CS, WE, OE, D_in; Output: D (symmetric, offs=2)
      return buildGenericShapePins(5, 1, 3, false, invertedLabels, ["A", "CS", "WE", "OE", "D_in"]);

    case "EEPROMDualPort":
      // Inputs: A, CS, WE, OE, D_in, ld; Output: D (symmetric, offs=3)
      return buildGenericShapePins(6, 1, 3, false, invertedLabels, ["A", "CS", "WE", "OE", "D_in", "ld"]);

    // ===================================================================
    // Wiring — specialized shapes already covered above; add Decoder
    // ===================================================================

    case "Decoder": {
      // Same shape as Demultiplexer (DemuxerShape), no data input
      const selBits = (props["selectorBits"] as number) ?? 1;
      const outCount = 1 << selBits;
      const height = outCount;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "sel", x: 1, y: flip ? 0 : height });
      if (outCount === 2) {
        pins.push({ label: "out_0", x: 2, y: 0 });
        pins.push({ label: "out_1", x: 2, y: 2 });
      } else {
        for (let i = 0; i < outCount; i++) {
          pins.push({ label: `out_${i}`, x: 2, y: i });
        }
      }
      return pins;
    }

    // ===================================================================
    // Misc — Testcase has no pins, Rectangle is decorative
    // ===================================================================
    case "Testcase":
    case "Rectangle":
    case "GenericInitCode":
      return null; // Not circuit elements with pins

    default:
      // Subcircuits and remaining specialized components — not yet covered
      return null;
  }
}

/**
 * Java's pin transform: rotate then translate, optionally with mirror.
 * Mirror matrix [1,0;0,-1] composed AFTER rotate+translate.
 */
function javaWorldPosition(
  localX: number,
  localY: number,
  posX: number,
  posY: number,
  rotation: number,
  mirror: boolean,
): { x: number; y: number } {
  const mats: Record<number, { cos: number; sin: number }> = {
    0: { cos: 1, sin: 0 },
    1: { cos: 0, sin: 1 },
    2: { cos: -1, sin: 0 },
    3: { cos: 0, sin: -1 },
  };
  const { cos, sin } = mats[rotation] ?? mats[0];

  if (!mirror) {
    return {
      x: localX * cos + localY * sin + posX,
      y: -localX * sin + localY * cos + posY,
    };
  }

  // Combined = Transform.mul(mirror[1,0,0,-1], rotateTranslate)
  // Result matrix: [cos, -sin, -sin, -cos, posX, posY]
  return {
    x: localX * cos - localY * sin + posX,
    y: -(localX * sin + localY * cos) + posY,
  };
}

// ---------------------------------------------------------------------------
// Test setup
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

// ---------------------------------------------------------------------------
// Track per-component-type mismatches across ALL fixtures
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
// Per-fixture test
// ---------------------------------------------------------------------------

describe("shape audit — pin position comparison vs Java Digital", () => {
  let registry: ComponentRegistry;

  beforeAll(() => {
    registry = createDefaultRegistry();
  });

  if (fixtures.length === 0) {
    it.skip("no fixtures found", () => {});
    return;
  }

  // Run all fixtures, collecting mismatches
  describe.each(fixtures)("$label", ({ label, path, dir }) => {
    it("pin positions match Java reference", async () => {
      clearSubcircuitCache();
      const xml = readFileSync(path, "utf-8");
      const resolver = new FixtureTreeResolver(digIndex, dir);

      let circuit: Circuit;
      try {
        circuit = await loadWithSubcircuits(xml, resolver, registry);
      } catch {
        // Skip files that fail to load — fixture-audit.test covers that
        return;
      }

      for (const el of circuit.elements) {
        // Build a simple props record from the element
        const props: Record<string, unknown> = {};
        if ("_properties" in el) {
          const bag = (el as any)._properties;
          if (bag && typeof bag.getOrDefault === "function") {
            // Extract common props
            for (const key of [
              "bitWidth", "inputCount", "flipSelPos", "invertDriverOutput",
              "spreading", "input splitting", "output splitting", "selectorBits",
              "wideShape", "_inverterLabels", "withEnable",
            ]) {
              try {
                const v = bag.getOrDefault(key, undefined);
                if (v !== undefined) props[key] = v;
              } catch { /* ignore */ }
            }
          }
        }

        const javaPins = getJavaPinPositions(el.typeId, props);
        if (!javaPins) continue; // Unknown type, skip

        const tsPins = el.getPins();

        // Pin count mismatch — collect and report, don't silently skip
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

  // Summary test — runs after all fixtures
  it("summary: zero pin position mismatches", () => {
    if (allMismatches.length === 0) return;

    // Group by typeId for readable output
    const byType = new Map<string, PinMismatch[]>();
    for (const m of allMismatches) {
      const key = m.typeId;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key)!.push(m);
    }

    const lines: string[] = [];
    lines.push(`\n${allMismatches.length} pin position mismatch(es) across ${byType.size} component type(s):\n`);

    for (const [typeId, mismatches] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      // Deduplicate by rotation+mirror+delta pattern
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

    // Fail with count — but let the console output above give the details
    expect(allMismatches.length, lines.join("\n")).toBe(0);
  });

  // Summary test — pin count mismatches
  it("summary: zero pin count mismatches", () => {
    if (allCountMismatches.length === 0) return;

    // Group by typeId
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

// ---------------------------------------------------------------------------
// Dimension audit — compare TS getBoundingBox() local dimensions against
// Java reference dimensions for each component type.
//
// Java reference dimensions are in grid units (SIZE=1, SIZE2=0.5).
// For GenericShape: body rect from (0, -topBottomBorder) to (width, yBottom)
//   topBottomBorder = 0.5 (SIZE2)
//   yBottom = (max-1) + 0.5 + (symmetric && even ? 1 : 0)
//   bodyHeight = yBottom + 0.5
//
// For IO shapes (Clock, Const, In, Out, Button):
//   Java uses OUT_SIZE=15px=0.75 grid for the body polygon.
//   Const is text-only with no body rect at all.
// ---------------------------------------------------------------------------

interface JavaDimRef {
  /** Expected local bbox width (grid units) */
  width: number;
  /** Expected local bbox height (grid units) */
  height: number;
  /** Optional tolerance (default 0.5 grid units) */
  tolerance?: number;
}

/**
 * Returns expected local bounding box dimensions for a component type.
 * Returns null if no reference is available.
 *
 * These are approximate: we check that the TS bbox width/height are
 * within tolerance of the Java reference, catching grossly oversized
 * or undersized components.
 */
function getJavaDimensions(
  typeId: string,
  props: Record<string, unknown>,
): JavaDimRef | null {
  const inputCount = (props["inputCount"] as number) ?? 2;

  switch (typeId) {
    // IO: Java ClockShape polygon ~ 1.5 × 1.5 grid (OUT_SIZE=0.75)
    case "Clock":
      return { width: 1.5, height: 1.5 };

    // IO: Java ConstShape is text-only, no body rect. Max ~1 grid wide.
    case "Const":
      return { width: 1, height: 1, tolerance: 0.7 };

    // IO: Java InputShape/OutputShape ~ 1.5 × 1.5 (OUT_SIZE=0.75)
    case "In":
    case "Out":
    case "Button":
      return { width: 1.5, height: 1.5 };

    // Zero-size: Probe is text-only, Tunnel is a small triangle
    case "Probe":
      return { width: 0.5, height: 0.5, tolerance: 1.0 };
    case "Tunnel":
      return { width: 1, height: 1, tolerance: 0.5 };

    // Gates: GenericShape body rect
    case "And": case "Or": case "XOr":
    case "NAnd": case "NOr": case "XNOr": {
      const n = inputCount;
      const wide = !!(props["wideShape"] ?? false);
      const w = (n === 1 ? 1 : 3) + (wide ? 1 : 0);
      const even = n > 0 && (n & 1) === 0;
      const max = n;
      const bodyH = (max - 1) + 0.5 + (even ? 1 : 0) + 0.5;
      // Inverted gates (NAnd etc.) add 1 grid unit for bubble
      const isInverted = ["NAnd", "NOr", "XNOr"].includes(typeId);
      return { width: w + (isInverted ? 1 : 0), height: bodyH };
    }
    case "Not": {
      const wide = !!(props["wideShape"] ?? false);
      const w = 1 + (wide ? 1 : 0);
      return { width: w + 1, height: 1 }; // +1 for inversion bubble
    }

    // Flip-flops: GenericShape, width=3
    case "D_FF":
    case "RS_FF_AS":
    case "Monoflop":
      return { width: 3, height: 2 }; // 2 inputs or 2in/2out, symmetric
    case "JK_FF":
    case "RS_FF":
      return { width: 3, height: 3 }; // 3 inputs
    case "D_FF_AS":
      return { width: 3, height: 4 }; // 4 inputs
    case "JK_FF_AS":
      return { width: 3, height: 5 }; // 5 inputs

    // Arithmetic: GenericShape, width=3
    case "Add": case "Sub":
      return { width: 3, height: 3 }; // 3 inputs, 2 outputs
    case "Comparator":
      return { width: 3, height: 3 }; // 2 inputs, 3 outputs (max=3)
    case "Neg":
      return { width: 3, height: 1 }; // 1 input, 1 output

    // Memory: GenericShape, width=3
    case "Register":
      return { width: 3, height: 3 }; // 3 inputs
    case "Counter":
      return { width: 3, height: 3 }; // 3 inputs
    case "CounterPreset":
      return { width: 3, height: 7 }; // 6 inputs, 2 outputs (max=6)

    // Wiring
    case "Driver":
      return { width: 2, height: 2 };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dimension comparison across fixtures
// ---------------------------------------------------------------------------

interface DimMismatch {
  fixture: string;
  typeId: string;
  expected: { width: number; height: number };
  actual: { width: number; height: number };
}

const allDimMismatches: DimMismatch[] = [];

describe("dimension audit — bounding box comparison vs Java Digital", () => {
  let registry: ComponentRegistry;

  beforeAll(() => {
    registry = createDefaultRegistry();
  });

  if (fixtures.length === 0) {
    it.skip("no fixtures found", () => {});
    return;
  }

  describe.each(fixtures)("$label", ({ label, path, dir }) => {
    it("component dimensions match Java reference", async () => {
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
        const props: Record<string, unknown> = {};
        if ("_properties" in el) {
          const bag = (el as any)._properties;
          if (bag && typeof bag.getOrDefault === "function") {
            for (const key of ["bitWidth", "inputCount", "wideShape"]) {
              try {
                const v = bag.getOrDefault(key, undefined);
                if (v !== undefined) props[key] = v;
              } catch { /* ignore */ }
            }
          }
        }

        const javaDims = getJavaDimensions(el.typeId, props);
        if (!javaDims) continue;

        const bb = el.getBoundingBox();
        const tol = javaDims.tolerance ?? 0.5;

        if (
          Math.abs(bb.width - javaDims.width) > tol ||
          Math.abs(bb.height - javaDims.height) > tol
        ) {
          allDimMismatches.push({
            fixture: label,
            typeId: el.typeId,
            expected: { width: javaDims.width, height: javaDims.height },
            actual: { width: bb.width, height: bb.height },
          });
        }
      }
    });
  });

  it("summary: zero dimension mismatches", () => {
    if (allDimMismatches.length === 0) return;

    const byType = new Map<string, DimMismatch[]>();
    for (const m of allDimMismatches) {
      if (!byType.has(m.typeId)) byType.set(m.typeId, []);
      byType.get(m.typeId)!.push(m);
    }

    const lines: string[] = [];
    lines.push(`\n${allDimMismatches.length} dimension mismatch(es) across ${byType.size} component type(s):\n`);

    for (const [typeId, mismatches] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const example = mismatches[0];
      lines.push(
        `  ${typeId} — expected ~${example.expected.width}×${example.expected.height}, got ${example.actual.width}×${example.actual.height} (×${mismatches.length} instances)`,
      );
    }

    console.log(lines.join("\n"));
    expect(allDimMismatches.length, lines.join("\n")).toBe(0);
  });
});
