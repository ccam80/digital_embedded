/**
 * Central fixtures for analog engine tests.
 *
 * Two construction paths:
 *
 *   1. compile* helpers- production path: build a Circuit from real
 *      ComponentDefinitions and run compileUnified. Use these for any test
 *      whose intent is "engine behaviour on a real-shape circuit".
 *
 *   2. wrapHandElements- direct-element path for tests that need to inject
 *      a custom AnalogElement (acceptStep stubs, fuses, etc.). Builds a real
 *      ConcreteCompiledAnalogCircuit with a placeholder StatePool- the
 *      engine's _setup() allocates the canonical pool and writes it back
 *      (single-ownership invariant in MNAEngine._setup).
 *
 * Tests must never reach inside ConcreteCompiledAnalogCircuit via casts to
 * fabricate fixtures; that path bypasses the compiler's invariants and
 * fights the engine for state-pool ownership.
 */

import { Circuit, Wire } from "../../../../core/circuit.js";
import type { CircuitElement } from "../../../../core/element.js";
import type { Pin } from "../../../../core/pin.js";
import { PinDirection } from "../../../../core/pin.js";
import { PropertyBag } from "../../../../core/properties.js";
import type { PropertyValue } from "../../../../core/properties.js";
import type { Rect, RenderContext } from "../../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../../core/element.js";
import { ComponentRegistry, type AnalogFactory } from "../../../../core/registry.js";
import { compileUnified } from "@/compile/compile.js";

import { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import { StatePool } from "../../state-pool.js";
import type { AnalogElement } from "../../element.js";

import { ResistorDefinition } from "../../../../components/passives/resistor.js";
import { DcVoltageSourceDefinition, makeDcVoltageSource } from "../../../../components/sources/dc-voltage-source.js";
import { CapacitorDefinition, AnalogCapacitorElement, CAPACITOR_DEFAULTS } from "../../../../components/passives/capacitor.js";
import { DiodeDefinition, createDiodeElement, DIODE_PARAM_DEFAULTS } from "../../../../components/semiconductors/diode.js";
import { GroundDefinition } from "../../../../components/io/ground.js";
import { ProbeDefinition } from "../../../../components/io/probe.js";
import { AnalogFuseElement } from "../../../../components/passives/analog-fuse.js";
import { AnalogInductorElement, INDUCTOR_DEFAULTS } from "../../../../components/passives/inductor.js";

// ---------------------------------------------------------------------------
// Production-path helpers
// ---------------------------------------------------------------------------

export function buildAnalogRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(ResistorDefinition);
  registry.register(DcVoltageSourceDefinition);
  registry.register(CapacitorDefinition);
  registry.register(DiodeDefinition);
  registry.register(ProbeDefinition);
  return registry;
}

function makePin(x: number, y: number, label: string = ""): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    bitWidth: 1,
    kind: "signal" as const,
  };
}

export function makeAnalogElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
  registry?: ComponentRegistry,
): CircuitElement {
  const def = registry?.get(typeId);
  const resolvedPins = pins.map((p, i) => makePin(p.x, p.y, p.label || def?.pinLayout[i]?.label || ""));
  const propertyBag = new PropertyBag(propsMap.entries());
  const _mp: Record<string, number> = {};
  for (const [k, v] of propsMap) if (typeof v === "number") _mp[k] = v;
  propertyBag.replaceModelParams(_mp);

  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };

  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
    setAttribute(k: string, v: PropertyValue) { propsMap.set(k, v); },
  };
}

function compileOrThrow(circuit: Circuit, registry: ComponentRegistry): ConcreteCompiledAnalogCircuit {
  const compiled = compileUnified(circuit, registry).analog;
  if (!compiled) {
    throw new Error("compileUnified produced no analog circuit");
  }
  const errors = compiled.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    throw new Error(`compile errors: ${errors.map((e) => e.code).join(", ")}`);
  }
  return compiled as ConcreteCompiledAnalogCircuit;
}

// ---------------------------------------------------------------------------
// Direct-element wrapper- uses the real ConcreteCompiledAnalogCircuit ctor
// with a StatePool(0) placeholder. MNAEngine._setup() allocates the real
// pool and writes it back to compiled.statePool, so engine + cac end up
// pointing at the same object (single ownership).
// ---------------------------------------------------------------------------

export function wrapHandElements(opts: {
  nodeCount: number;
  elements: AnalogElement[];
  labelToNodeId?: Map<string, number>;
}): ConcreteCompiledAnalogCircuit {
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    elements: opts.elements,
    labelToNodeId: opts.labelToNodeId ?? new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool: new StatePool(0), // placeholder; engine._setup() replaces it
  });
}

// ---------------------------------------------------------------------------
// Hand-element circuit recipes- tests requiring direct element control.
// Most tests should prefer the production-path compile* helpers below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline production factory helpers- used by hand-element circuit recipes.
// These replace the deleted positional-argument helpers from test-helpers.js.
// ---------------------------------------------------------------------------

function makeVoltageSource(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ resistance });
  const factory = (ResistorDefinition.modelRegistry!["behavioral"] as { factory: AnalogFactory }).factory;
  return factory(new Map([["pos", nodeA], ["neg", nodeB]]), props, () => 0);
}

function createTestCapacitor(capacitance: number, posNode: number, negNode: number): AnalogElement {
  const capProps = new PropertyBag();
  capProps.replaceModelParams({ ...CAPACITOR_DEFAULTS, capacitance });
  return new AnalogCapacitorElement(
    new Map([["pos", posNode], ["neg", negNode]]),
    capProps,
  );
}

function makeInductor(posNode: number, negNode: number, inductance: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...INDUCTOR_DEFAULTS, inductance });
  return new AnalogInductorElement(
    new Map([["pos", posNode], ["neg", negNode]]),
    props,
  );
}

function makeDiode(anodeNode: number, cathodeNode: number, IS: number, N: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, IS, N });
  return createDiodeElement(new Map([["A", anodeNode], ["K", cathodeNode]]), props, () => 0);
}

export interface DividerOpts { R1?: number; R2?: number; V?: number }

/** Vs(node1, 0, branch=2) → R1(node1→node2) → R2(node2→0). */
export function dividerCircuit(opts: DividerOpts = {}): ConcreteCompiledAnalogCircuit {
  const { R1 = 1000, R2 = 1000, V = 5 } = opts;
  return wrapHandElements({
    nodeCount: 2,
    elements: [
      makeVoltageSource(1, 0, V),
      makeResistor(1, 2, R1),
      makeResistor(2, 0, R2),
    ],
    labelToNodeId: new Map([["V_mid", 2]]),
  });
}

/** Vs(node1, 0, branch=2) → R(node1→node2) → C(node2→0).
 *  RC = R*C. Cap is the production AnalogCapacitorElement. */
export function rcCircuit(opts: { R?: number; C?: number; V?: number } = {}): ConcreteCompiledAnalogCircuit {
  const { R = 1000, C = 1e-6, V = 5 } = opts;
  return wrapHandElements({
    nodeCount: 2,
    elements: [
      makeVoltageSource(1, 0, V),
      makeResistor(1, 2, R),
      createTestCapacitor(C, 2, 0),
    ],
  });
}

/** Vs(node1, 0, branch=2) → R(node1→node2) → L(node2→0, branch=3). */
export function rlCircuit(opts: { R?: number; L?: number; V?: number } = {}): ConcreteCompiledAnalogCircuit {
  const { R = 100, L = 10e-3, V = 5 } = opts;
  return wrapHandElements({
    nodeCount: 2,
    elements: [
      makeVoltageSource(1, 0, V),
      makeResistor(1, 2, R),
      makeInductor(2, 0, L),
    ],
  });
}

/** Vs(node1, 0, branch=2) → R(node1→node2) → Diode(node2→0). */
export function diodeCircuit(opts: { R?: number; V?: number; Is?: number; n?: number } = {}): ConcreteCompiledAnalogCircuit {
  const { R = 1000, V = 5, Is = 1e-14, n = 1.0 } = opts;
  return wrapHandElements({
    nodeCount: 2,
    elements: [
      makeVoltageSource(1, 0, V),
      makeResistor(1, 2, R),
      makeDiode(2, 0, Is, n),
    ],
  });
}

/** Fuse circuit: Vs → fuse → load resistor → ground.
 *  Constructs AnalogFuseElement via production constructor (pinNodes first). */
export function fuseCircuit(opts: {
  V?: number;
  rCold?: number;
  rBlown?: number;
  i2tRating?: number;
  rLoad?: number;
}): { circuit: ConcreteCompiledAnalogCircuit; fuse: AnalogFuseElement } {
  const { V = 5, rCold = 1.0, rBlown = 1e9, i2tRating = 1e-8, rLoad = 9.0 } = opts;
  const fuse = new AnalogFuseElement(
    new Map([["out1", 1], ["out2", 2]]),
    rCold,
    rBlown,
    i2tRating,
  );

  const circuit = wrapHandElements({
    nodeCount: 2,
    elements: [
      makeVoltageSource(1, 0, V),
      fuse as unknown as AnalogElement,
      makeResistor(2, 0, rLoad),
    ],
  });
  return { circuit, fuse };
}

// ---------------------------------------------------------------------------
// Production-path circuit recipes (compileUnified)
// ---------------------------------------------------------------------------

function addSelfLoopWires(circuit: Circuit, xs: number[]): void {
  for (const x of xs) {
    circuit.addWire(new Wire({ x, y: 0 }, { x, y: 1 }));
  }
}

/** Resistor divider via compileUnified.
 *  Layout: x=10 (Vs+ / R1.A), x=20 (R1.B / R2.A → "V_mid"), x=30 (R2.B / Vs- / GND). */
export function compileDivider(opts: DividerOpts = {}): ConcreteCompiledAnalogCircuit {
  const { R1 = 1000, R2 = 1000, V = 5 } = opts;
  const registry = buildAnalogRegistry();
  const circuit = new Circuit();

  circuit.addElement(makeAnalogElement("DcVoltageSource", "vs1",
    [{ x: 30, y: 0 }, { x: 10, y: 0 }],
    new Map<string, PropertyValue>([["voltage", V]]), registry));
  circuit.addElement(makeAnalogElement("Resistor", "r1",
    [{ x: 10, y: 0 }, { x: 20, y: 0 }],
    new Map<string, PropertyValue>([["resistance", R1]]), registry));
  circuit.addElement(makeAnalogElement("Resistor", "r2",
    [{ x: 20, y: 0 }, { x: 30, y: 0 }],
    new Map<string, PropertyValue>([["resistance", R2]]), registry));
  circuit.addElement(makeAnalogElement("Ground", "gnd1", [{ x: 30, y: 0 }], new Map(), registry));
  circuit.addElement(makeAnalogElement("Probe", "probe1",
    [{ x: 20, y: 0 }],
    new Map<string, PropertyValue>([["label", "V_mid"]]), registry));

  addSelfLoopWires(circuit, [10, 20, 30]);
  return compileOrThrow(circuit, registry);
}

/** Diode circuit via compileUnified: Vs=V → R → Diode → GND. */
export function compileDiode(opts: { R?: number; V?: number } = {}): ConcreteCompiledAnalogCircuit {
  const { R = 1000, V = 5 } = opts;
  const registry = buildAnalogRegistry();
  const circuit = new Circuit();

  circuit.addElement(makeAnalogElement("DcVoltageSource", "vs1",
    [{ x: 30, y: 0 }, { x: 10, y: 0 }],
    new Map<string, PropertyValue>([["voltage", V]]), registry));
  circuit.addElement(makeAnalogElement("Resistor", "r1",
    [{ x: 10, y: 0 }, { x: 20, y: 0 }],
    new Map<string, PropertyValue>([["resistance", R]]), registry));
  circuit.addElement(makeAnalogElement("Diode", "d1",
    [{ x: 20, y: 0 }, { x: 30, y: 0 }], new Map(), registry));
  circuit.addElement(makeAnalogElement("Ground", "gnd1", [{ x: 30, y: 0 }], new Map(), registry));

  addSelfLoopWires(circuit, [10, 20, 30]);
  return compileOrThrow(circuit, registry);
}
