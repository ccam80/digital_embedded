import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import {
  BehavioralOutputDriverTriStateElement,
} from "../../../solver/analog/behavioral-output-driver.js";
import type { ComponentRegistry, StandaloneComponentDefinition } from "../../../core/registry.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Fixture = ReturnType<typeof buildFixture>;

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function findAnalogElementByLabel(fix: Fixture, label: string): AnalogElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    if (fix.elementLabels.get(i) === label) return fix.circuit.elements[i]!;
  }
  throw new Error(`AnalogElement with label '${label}' not found`);
}

// ---------------------------------------------------------------------------
// Thin test-wrapper for DigitalOutputPinTriStateLoaded (internalOnly composite)
//
// The composite wraps BehavioralOutputDriverTriState + Capacitor. Rather than
// trying to instantiate the internalOnly composite directly, we drive the
// underlying leaf element through a thin StandaloneComponentDefinition so the
// same AnalogElement class is exercised without modifying any production
// definition.
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

const TRISTATE_PIN_DECLS = [
  { label: "pos",  direction: PinDirection.OUTPUT },
  { label: "neg",  direction: PinDirection.INPUT  },
  { label: "ctrl", direction: PinDirection.INPUT  },
  { label: "en",   direction: PinDirection.INPUT  },
];

function buildTriStateWrapperDef(): StandaloneComponentDefinition {
  return {
    name: "_TestTriStateLoadedDrv",
    typeId: -1,
    pinLayout: TRISTATE_PIN_DECLS.map(p => makePinDecl(p.label, p.direction)),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    models: {},
    defaultModel: "default",
    factory: (props: PropertyBag): CircuitElement =>
      makeTestCircuitElement("_TestTriStateLoadedDrv", props, TRISTATE_PIN_DECLS),
    modelRegistry: {
      default: {
        kind: "inline",
        paramDefs: [
          { key: "vOH",  default: 5 },
          { key: "vOL",  default: 0 },
          { key: "rOut", default: 100 },
          { key: "rHiZ", default: 1e9 },
        ],
        params: { vOH: 5, vOL: 0, rOut: 100, rHiZ: 1e9 },
        branchCount: 0,
        factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag): AnalogElement =>
          new BehavioralOutputDriverTriStateElement(pinNodes, props),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function buildLoadedFixture(
  vEn: number,
  vCtrl: number,
  rLoad: number,
  rOut = 100,
  vOH = 5,
  vOL = 0,
  rHiZ = 1e9,
) {
  return (registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    registry.register(buildTriStateWrapperDef());
    return facade.build({
      components: [
        { id: "vsCtrl", type: "DcVoltageSource", props: { label: "vsCtrl", voltage: vCtrl } },
        { id: "vsEn",   type: "DcVoltageSource", props: { label: "vsEn",   voltage: vEn   } },
        { id: "drv",    type: "_TestTriStateLoadedDrv",
          props: { label: "drv", model: "default", vOH, vOL, rOut, rHiZ } },
        { id: "rLoad",  type: "Resistor", props: { label: "rLoad", resistance: rLoad } },
        { id: "cOut",   type: "Capacitor", props: { label: "cOut", capacitance: 1e-12 } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsCtrl:pos", "drv:ctrl"],
        ["vsCtrl:neg", "gnd:out"],
        ["vsEn:pos",   "drv:en"],
        ["vsEn:neg",   "gnd:out"],
        ["drv:neg",    "gnd:out"],
        ["drv:pos",    "rLoad:pos"],
        ["drv:pos",    "cOut:pos"],
        ["rLoad:neg",  "gnd:out"],
        ["cOut:neg",   "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DigitalOutputPinTriStateLoaded", () => {
  it("en high ctrl high stamps vOH at node", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000, rHiZ = 1e9;
    const fix = buildFixture({ build: buildLoadedFixture(vOH, vOH, rLoad, rOut, vOH, vOL, rHiZ) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    const expected = vOH * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("en high ctrl low stamps vOL at node", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000, rHiZ = 1e9;
    const fix = buildFixture({ build: buildLoadedFixture(vOH, vOL, rLoad, rOut, vOH, vOL, rHiZ) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    const expected = vOL * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("en low isolates node (high-Z, external pull dominates)", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1000, rHiZ = 1e9;
    const fix = buildFixture({ build: buildLoadedFixture(vOL, vOH, rLoad, rOut, vOH, vOL, rHiZ) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = Math.abs(fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode));
    // Bound: |vOut| < vOH * (1/rHiZ) * rLoad = 5 * (1/1e9) * 1000 = 5e-6 V
    const bound = vOH * (1 / rHiZ) * rLoad;
    expect(vOut).toBeLessThan(bound + 1e-9);
  });

  it("cOut RC charges node after en flips high", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000, rHiZ = 1e9;
    const cOut = 1e-12;
    // Start en=high, ctrl=high — after a warm-start step the node should be charged
    const tRC = 5 * cOut * rOut; // 500 ps
    const fix = buildFixture({
      build: buildLoadedFixture(vOH, vOH, rLoad, rOut, vOH, vOL, rHiZ),
      params: { tStop: tRC * 10, maxTimeStep: tRC },
    });

    // Step forward through 5*tau
    for (let i = 0; i < 10; i++) {
      fix.coordinator.step();
    }

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    expect(vOut).toBeGreaterThan(0.95 * vOH);
  });
});
