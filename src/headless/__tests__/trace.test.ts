/**
 * Tests for captureTrace — task 3.5.2.
 *
 * Verifies that captureTrace correctly samples signal values over multiple
 * simulation steps and returns properly sized arrays.
 */

import { describe, it, expect } from "vitest";
import { captureTrace } from "../trace.js";
import { SimulationRunner } from "../runner.js";
import { ComponentRegistry } from "@/core/registry";
import { PropertyBag, PropertyType } from "@/core/properties";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { ComponentLayout } from "@/core/registry";
import { Circuit } from "@/core/circuit";
import { BitVector } from "@/core/signal";

// ---------------------------------------------------------------------------
// Minimal test helpers (same pattern as runner.test.ts)
// ---------------------------------------------------------------------------

class MockElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: Pin[],
    props: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0 as Rotation, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 4, height: 4 }; }
  getHelpText(): string { return ""; }
}

function makePin(label: string, direction: PinDirection, localX: number, localY: number): Pin {
  return { label, direction, position: { x: localX, y: localY }, bitWidth: 1, isNegated: false, isClock: false };
}

function makePropBag(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) bag.set(k, v);
  return bag;
}

/**
 * Build a registry with In, Out, and a step-counter component.
 *
 * "Counter" increments its output by 1 each time step is called.
 */
function buildTracingRegistry(counterValues: number[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  let stepIndex = 0;

  registry.register({
    name: "In",
    typeId: -1,
    factory: (props) => new MockElement("In", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: () => {},
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
    attributeMap: [],
    category: "IO" as any,
    helpText: "In",
  });

  registry.register({
    name: "Out",
    typeId: -1,
    factory: (props) => new MockElement("Out", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in", PinDirection.INPUT, 4, 0),
    ], props),
    executeFn: () => {},
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
    attributeMap: [],
    category: "IO" as any,
    helpText: "Out",
  });

  registry.register({
    name: "Counter",
    typeId: -1,
    factory: (props) => new MockElement("Counter", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: (_index: number, state: Uint32Array, layout: ComponentLayout) => {
      const val = counterValues[stepIndex] ?? 0;
      stepIndex = (stepIndex + 1) % counterValues.length;
      state[layout.outputOffset(_index)] = val;
    },
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
    attributeMap: [],
    category: "LOGIC" as any,
    helpText: "Counter",
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Build a simple circuit: Counter "Y" → Out "Y"
// ---------------------------------------------------------------------------

function buildCounterCircuit(registry: ComponentRegistry): Circuit {
  const circuit = new Circuit();

  const counter = new MockElement("Counter", "counter", { x: 0, y: 0 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "Y" }));

  const out = new MockElement("Out", "out", { x: 3, y: 0 }, [
    makePin("in", PinDirection.INPUT, 1, 0),
  ], makePropBag({ label: "Y" }));

  circuit.elements.push(counter, out);
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);

  void registry;
  return circuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Trace", () => {
  // -------------------------------------------------------------------------
  // capturesMultipleSteps
  // -------------------------------------------------------------------------

  it("capturesMultipleSteps — 3-step trace of a signal, verify array has 3 entries", () => {
    const registry = buildTracingRegistry([0, 1, 0]);
    const runner = new SimulationRunner(registry);
    const circuit = buildCounterCircuit(registry);
    const engine = runner.compile(circuit);

    const trace = captureTrace(runner, engine, ["Y"], 3);

    expect(trace.has("Y")).toBe(true);
    expect(trace.get("Y")).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // valuesReflectStepProgression
  // -------------------------------------------------------------------------

  it("valuesReflectStepProgression — trace shows value changing at expected step", () => {
    // Counter output sequence: step 0 → 0, step 1 → 1, step 2 → 0
    const registry = buildTracingRegistry([0, 1, 0]);
    const runner = new SimulationRunner(registry);
    const circuit = buildCounterCircuit(registry);
    const engine = runner.compile(circuit);

    const trace = captureTrace(runner, engine, ["Y"], 3);
    const values = trace.get("Y")!;

    // Step 1: counter outputs 0
    expect(values[0]).toEqual(BitVector.fromNumber(0, 1));
    // Step 2: counter outputs 1
    expect(values[1]).toEqual(BitVector.fromNumber(1, 1));
    // Step 3: counter outputs 0
    expect(values[2]).toEqual(BitVector.fromNumber(0, 1));
  });
});
