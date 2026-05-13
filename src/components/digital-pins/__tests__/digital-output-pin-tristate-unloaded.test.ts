import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import {
  buildDigitalOutputPinTriStateUnloadedNetlist,
} from "../digital-output-pin-tristate-unloaded.js";
import type { ComponentRegistry, StandaloneComponentDefinition } from "../../../core/registry.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Fixture = ReturnType<typeof buildFixture>;

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Thin test-wrapper for DigitalOutputPinTriStateUnloaded (internalOnly composite)
//
// Uses kind: "netlist" referencing buildDigitalOutputPinTriStateUnloadedNetlist so
// the composite's port-to-pin mapping [0, 1, 2, 3] is verified through the compiler.
//
// en/ctrl carry NORMALIZED logic-level signals in {0, 1} V per the new
// digital→analog pin-boundary architecture (see digital-output-pin-unloaded.ts
// docblock).
// ---------------------------------------------------------------------------

let _pinGroupCounter = 0;

function makeTestPin(label: string, direction: PinDirection, x: number, y: number): Pin {
  return {
    label,
    direction,
    bitWidth: 1,
    isNegated: false,
    isClock: false,
    kind: "signal" as const,
    position: { x, y },
  };
}

function makeTestCircuitElement(
  typeId: string,
  props: PropertyBag,
  pinDecls: Array<{ label: string; direction: PinDirection }>,
): CircuitElement {
  const baseX = (_pinGroupCounter++) * 1000;
  const pins = pinDecls.map((pd, i) =>
    makeTestPin(pd.label, pd.direction, baseX + i * 10, 0),
  );
  return {
    typeId,
    instanceId: crypto.randomUUID(),
    position: { x: baseX, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return pins; },
    getProperties() { return props; },
    getBoundingBox() { return { x: baseX, y: 0, width: 10, height: 10 }; },
    draw() { /* no-op */ },
    serialize() {
      return {
        typeId,
        instanceId: this.instanceId,
        position: this.position,
        rotation: this.rotation,
        mirror: this.mirror,
        properties: {},
      };
    },
    getAttribute(k: string) { return props.has(k) ? props.get(k) : undefined; },
    setAttribute(k: string, v) { props.set(k, v); },
  };
}

function makePinDecl(label: string, direction: PinDirection) {
  return {
    label,
    direction,
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal" as const,
  };
}

const UNLOADED_TRISTATE_PIN_DECLS = [
  { label: "node", direction: PinDirection.OUTPUT },
  { label: "gnd",  direction: PinDirection.OUTPUT },
  { label: "ctrl", direction: PinDirection.INPUT  },
  { label: "en",   direction: PinDirection.INPUT  },
];

const DEFAULT_RHIZ = 1e9;

function buildUnloadedWrapperDef(): StandaloneComponentDefinition {
  return {
    name: "_TestDigitalOutputPinTriStateUnloaded",
    typeId: -1,
    pinLayout: UNLOADED_TRISTATE_PIN_DECLS.map(p => makePinDecl(p.label, p.direction)),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    models: {},
    defaultModel: "default",
    factory: (props: PropertyBag): CircuitElement =>
      makeTestCircuitElement("_TestDigitalOutputPinTriStateUnloaded", props, UNLOADED_TRISTATE_PIN_DECLS),
    modelRegistry: {
      default: {
        kind: "netlist",
        netlist: buildDigitalOutputPinTriStateUnloadedNetlist,
        paramDefs: [
          { key: "rOut",  default: 100 },
          { key: "vOH",   default: 5 },
          { key: "vOL",   default: 0 },
          { key: "rHiZ",  default: DEFAULT_RHIZ },
          { key: "midEn", default: 0.5 },
        ],
        params: { rOut: 100, vOH: 5, vOL: 0, rHiZ: DEFAULT_RHIZ, midEn: 0.5 },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function buildUnloadedFixture(
  vEn: number,
  vCtrl: number,
  rLoad: number,
  rOut = 100,
  vOH = 5,
  vOL = 0,
  rHiZ = DEFAULT_RHIZ,
) {
  return (registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    registry.register(buildUnloadedWrapperDef());
    return facade.build({
      components: [
        { id: "vsCtrl", type: "DcVoltageSource", props: { label: "vsCtrl", voltage: vCtrl } },
        { id: "vsEn",   type: "DcVoltageSource", props: { label: "vsEn",   voltage: vEn   } },
        { id: "pin",    type: "_TestDigitalOutputPinTriStateUnloaded",
          props: { label: "pin", model: "default", vOH, vOL, rOut, rHiZ } },
        { id: "rLoad",  type: "Resistor", props: { label: "rLoad", resistance: rLoad } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsCtrl:pos", "pin:ctrl"],
        ["vsCtrl:neg", "gnd:out"],
        ["vsEn:pos",   "pin:en"],
        ["vsEn:neg",   "gnd:out"],
        ["pin:gnd",    "gnd:out"],
        ["pin:node",   "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DigitalOutputPinTriStateUnloaded", () => {
  it("en=1 ctrl=1 produces vOH at node", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    const fix = buildFixture({ build: buildUnloadedFixture(1, 1, rLoad, rOut, vOH, vOL) });

    const nodeN = nodeOf(fix, "pin:node");
    const gndN  = nodeOf(fix, "pin:gnd");
    const vOut = fix.engine.getNodeVoltage(nodeN) - fix.engine.getNodeVoltage(gndN);
    const expected = vOH * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("en=1 ctrl=0 produces vOL at node", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    const fix = buildFixture({ build: buildUnloadedFixture(1, 0, rLoad, rOut, vOH, vOL) });

    const nodeN = nodeOf(fix, "pin:node");
    const gndN  = nodeOf(fix, "pin:gnd");
    const vOut = fix.engine.getNodeVoltage(nodeN) - fix.engine.getNodeVoltage(gndN);
    const expected = vOL * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("en=0 isolates node (rHiZ)", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1000;
    const fix = buildFixture({ build: buildUnloadedFixture(0, 1, rLoad, rOut, vOH, vOL) });

    const nodeN = nodeOf(fix, "pin:node");
    const gndN  = nodeOf(fix, "pin:gnd");
    const vOut = Math.abs(fix.engine.getNodeVoltage(nodeN) - fix.engine.getNodeVoltage(gndN));
    // Bound: |vOut| < vOH · rLoad / rHiZ = 5 · 1000 / 1e9 = 5e-6 V
    const bound = vOH * (1 / DEFAULT_RHIZ) * rLoad;
    expect(vOut).toBeLessThan(bound);
  });
});
