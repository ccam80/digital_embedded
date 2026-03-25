/**
 * Tests for AnalogTooltip.
 *
 * Uses vitest fake timers for the 200ms hover delay tests.
 * Uses lightweight mock objects — no DOM, no canvas required for the
 * logic-only tests (wire voltage, component current/power, delay, leave).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AnalogTooltip } from "@/editor/analog-tooltip";
import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { CompiledAnalogCircuit } from "@/core/analog-engine-interface";
import type { HitResult } from "@/editor/hit-test";
import { Wire } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeEngine(opts: {
  nodeVoltages?: Record<number, number>;
  elementCurrents?: Record<number, number>;
  elementPowers?: Record<number, number>;
}): AnalogEngine {
  return {
    getNodeVoltage: (id: number) => opts.nodeVoltages?.[id] ?? 0,
    getElementCurrent: (id: number) => opts.elementCurrents?.[id] ?? 0,
    getElementPower: (id: number) => opts.elementPowers?.[id] ?? 0,
    // Unused Engine interface methods — minimal stubs.
    getBranchCurrent: () => 0,
    simTime: 0,
    lastDt: 0,
    dcOperatingPoint: () => { throw new Error("not used"); },
    configure: () => {},
    onDiagnostic: () => {},
    addBreakpoint: () => {},
    clearBreakpoints: () => {},
    // Engine base
    step: () => ({ accepted: true, dt: 0 }),
    reset: () => {},
    compile: () => { throw new Error("not used"); },
  } as unknown as AnalogEngine;
}

function makeWire(): Wire {
  return new Wire({ x: 0, y: 0 }, { x: 10, y: 0 });
}

function makeCircuitElement(pinLabels: string[] = []): CircuitElement {
  return {
    getPins: () => pinLabels.map((label, i) => ({
      label,
      position: { x: i, y: 0 },
      direction: "INPUT" as const,
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    })),
    getBoundingBox: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    position: { x: 0, y: 0 },
    rotation: 0,
    mirror: false,
  } as unknown as CircuitElement;
}

function makeCompiled(opts: {
  wire?: Wire;
  wireNodeId?: number;
  element?: CircuitElement;
  elementIndex?: number;
  elementNodeIndices?: number[];
}): CompiledAnalogCircuit {
  const wireToNodeId = new Map<Wire, number>();
  if (opts.wire !== undefined && opts.wireNodeId !== undefined) {
    wireToNodeId.set(opts.wire, opts.wireNodeId);
  }

  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elements: { pinNodeIds: number[]; allNodeIds: number[] }[] = [];

  if (opts.element !== undefined && opts.elementIndex !== undefined) {
    elementToCircuitElement.set(opts.elementIndex, opts.element);
    elements[opts.elementIndex] = {
      pinNodeIds: opts.elementNodeIndices ?? [1],
      allNodeIds: opts.elementNodeIndices ?? [1],
    };
  }

  return {
    wireToNodeId,
    elementToCircuitElement,
    elements,
    nodeCount: 5,
    elementCount: elements.length,
    labelToNodeId: new Map(),
    // CompiledCircuit base
    netCount: 5,
    componentCount: elements.length,
  } as unknown as CompiledAnalogCircuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tooltip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wire_shows_voltage", () => {
    const wire = makeWire();
    const engine = makeEngine({ nodeVoltages: { 3: 3.3 } });
    const compiled = makeCompiled({ wire, wireNodeId: 3 });

    const tooltip = new AnalogTooltip(engine, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any, compiled);

    const hit: HitResult = { type: "wire", wire };
    // Move mouse so timer fires immediately (we'll check text directly).
    vi.useFakeTimers();
    tooltip.onMouseMove(100, 100, hit);
    vi.advanceTimersByTime(250);

    expect(tooltip.text).toBe("3.30 V");
    expect(tooltip.visible).toBe(true);
  });

  it("component_shows_current_and_power", () => {
    const element = makeCircuitElement(["A", "B"]);
    const engine = makeEngine({ elementCurrents: { 0: 0.005 }, elementPowers: { 0: 0.025 } });
    const compiled = makeCompiled({ element, elementIndex: 0, elementNodeIndices: [1, 2] });

    const tooltip = new AnalogTooltip(engine, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any, compiled);

    const hit: HitResult = { type: "element", element };
    vi.useFakeTimers();
    tooltip.onMouseMove(50, 50, hit);
    vi.advanceTimersByTime(250);

    expect(tooltip.text).toContain("5.00 mA");
    expect(tooltip.text).toContain("25.0 mW");
    expect(tooltip.visible).toBe(true);
  });

  it("delay_200ms", () => {
    vi.useFakeTimers();

    const wire = makeWire();
    const engine = makeEngine({ nodeVoltages: { 1: 1.0 } });
    const compiled = makeCompiled({ wire, wireNodeId: 1 });

    const tooltip = new AnalogTooltip(engine, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any, compiled);

    const hit: HitResult = { type: "wire", wire };
    tooltip.onMouseMove(0, 0, hit);

    // At 100ms — not yet visible.
    vi.advanceTimersByTime(100);
    expect(tooltip.visible).toBe(false);

    // At 250ms total (100 + 150) — now visible.
    vi.advanceTimersByTime(150);
    expect(tooltip.visible).toBe(true);
  });

  it("disappears_on_leave", () => {
    vi.useFakeTimers();

    const wire = makeWire();
    const engine = makeEngine({ nodeVoltages: { 1: 5.0 } });
    const compiled = makeCompiled({ wire, wireNodeId: 1 });

    const tooltip = new AnalogTooltip(engine, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any, compiled);

    const hit: HitResult = { type: "wire", wire };
    tooltip.onMouseMove(0, 0, hit);
    vi.advanceTimersByTime(250);
    expect(tooltip.visible).toBe(true);

    // Leave — tooltip must disappear immediately.
    tooltip.onMouseLeave();
    expect(tooltip.visible).toBe(false);
  });
});
