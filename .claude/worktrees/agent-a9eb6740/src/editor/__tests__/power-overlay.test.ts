/**
 * Tests for PowerOverlay.
 *
 * Uses MockRenderContext to record draw calls. All tests are headless.
 */

import { describe, it, expect } from "vitest";
import { PowerOverlay } from "@/editor/power-overlay";
import { MockRenderContext } from "@/test-utils/mock-render-context";
import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { CompiledAnalogCircuit } from "@/core/analog-engine-interface";
import type { Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import { hexToRgb } from "@/editor/color-interpolation";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeEngine(elementPowers: Record<number, number>): AnalogEngine {
  return {
    getElementPower: (id: number) => elementPowers[id] ?? 0,
    getElementCurrent: () => 0,
    getNodeVoltage: () => 0,
    getBranchCurrent: () => 0,
    simTime: 0,
    lastDt: 0,
    dcOperatingPoint: () => { throw new Error("not used"); },
    configure: () => {},
    onDiagnostic: () => {},
    addBreakpoint: () => {},
    clearBreakpoints: () => {},
    step: () => ({ accepted: true, dt: 0 }),
    reset: () => {},
    compile: () => { throw new Error("not used"); },
  } as unknown as AnalogEngine;
}

function makeElement(x: number, y: number, w = 10, h = 10): CircuitElement {
  return {
    getBoundingBox: () => ({ x, y, width: w, height: h }),
    getPins: () => [],
    position: { x, y },
    rotation: 0,
    mirror: false,
  } as unknown as CircuitElement;
}

function makeCompiled(
  elementMap: Map<number, CircuitElement>,
): CompiledAnalogCircuit {
  return {
    elementToCircuitElement: elementMap,
    wireToNodeId: new Map(),
    elements: [],
    nodeCount: 0,
    elementCount: 0,
    labelToNodeId: new Map(),
    netCount: 0,
    componentCount: 0,
  } as unknown as CompiledAnalogCircuit;
}

function makeCircuit(elements: CircuitElement[]): Circuit {
  return {
    elements,
    wires: [],
  } as unknown as Circuit;
}

// Parse `rgb(r, g, b)` → [r, g, b]
function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m === null) throw new Error(`Not an rgb() string: ${css}`);
  return [parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PowerOverlay", () => {
  it("labels_mode_draws_text", () => {
    const el0 = makeElement(0, 0);
    const el1 = makeElement(20, 0);
    const el2 = makeElement(40, 0);

    const elementMap = new Map<number, CircuitElement>([
      [0, el0],
      [1, el1],
      [2, el2],
    ]);
    const engine = makeEngine({ 0: 0.01, 1: 0.5, 2: 0.1 });
    const compiled = makeCompiled(elementMap);
    const circuit = makeCircuit([el0, el1, el2]);

    const overlay = new PowerOverlay(engine, compiled);
    overlay.setMode("labels");

    const ctx = new MockRenderContext();
    overlay.render(ctx, circuit);

    const textCalls = ctx.callsOfKind("text");
    expect(textCalls.length).toBe(3);

    // Check that formatted values appear in the text calls.
    const texts = textCalls.map((c) => c.text);
    expect(texts.some((t) => t.includes("mW") || t.includes("W"))).toBe(true);
  });

  it("heatmap_highest_power_is_red", () => {
    const el0 = makeElement(0, 0);
    const elementMap = new Map<number, CircuitElement>([[0, el0]]);
    // Single element with all the power — normalized t = 1.0 → red.
    const engine = makeEngine({ 0: 100 });
    const compiled = makeCompiled(elementMap);
    const circuit = makeCircuit([el0]);

    const overlay = new PowerOverlay(engine, compiled);
    overlay.setMode("heatmap");

    const ctx = new MockRenderContext();
    overlay.render(ctx, circuit);

    const rawColors = ctx.callsOfKind("setRawColor");
    expect(rawColors.length).toBeGreaterThan(0);

    const [r, g, b] = parseRgb(rawColors[rawColors.length - 1]!.css);
    // Red: R dominant, G and B low.
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(100);
  });

  it("heatmap_lowest_power_is_yellow", () => {
    const el0 = makeElement(0, 0);
    const el1 = makeElement(20, 0);
    const elementMap = new Map<number, CircuitElement>([
      [0, el0],
      [1, el1],
    ]);
    // el0 has tiny power, el1 has max power (10W).
    const engine = makeEngine({ 0: 0.001, 1: 10 });
    const compiled = makeCompiled(elementMap);
    const circuit = makeCircuit([el0, el1]);

    const overlay = new PowerOverlay(engine, compiled);
    overlay.setMode("heatmap");

    const ctx = new MockRenderContext();
    overlay.render(ctx, circuit);

    const rawColors = ctx.callsOfKind("setRawColor");
    // First color corresponds to el0 (tiny power ≈ yellow #ffff00).
    expect(rawColors.length).toBeGreaterThanOrEqual(2);
    const [r, g, b] = parseRgb(rawColors[0]!.css);

    // Yellow: R ≈ 255, G ≈ 255, B ≈ 0. Allow ±10 tolerance.
    expect(r).toBeGreaterThanOrEqual(245);
    expect(g).toBeGreaterThanOrEqual(245);
    expect(b).toBeLessThanOrEqual(10);
  });

  it("off_mode_no_render", () => {
    const el0 = makeElement(0, 0);
    const elementMap = new Map<number, CircuitElement>([[0, el0]]);
    const engine = makeEngine({ 0: 5 });
    const compiled = makeCompiled(elementMap);
    const circuit = makeCircuit([el0]);

    const overlay = new PowerOverlay(engine, compiled);
    // Default mode is 'off'.
    expect(overlay.mode).toBe("off");

    const ctx = new MockRenderContext();
    overlay.render(ctx, circuit);

    // No draw calls at all in off mode.
    expect(ctx.calls.length).toBe(0);
  });

  it("zero_power_components_skipped_in_labels", () => {
    const el0 = makeElement(0, 0);
    const elementMap = new Map<number, CircuitElement>([[0, el0]]);
    // Zero power.
    const engine = makeEngine({ 0: 0 });
    const compiled = makeCompiled(elementMap);
    const circuit = makeCircuit([el0]);

    const overlay = new PowerOverlay(engine, compiled);
    overlay.setMode("labels");

    const ctx = new MockRenderContext();
    overlay.render(ctx, circuit);

    const textCalls = ctx.callsOfKind("text");
    expect(textCalls.length).toBe(0);
  });
});
