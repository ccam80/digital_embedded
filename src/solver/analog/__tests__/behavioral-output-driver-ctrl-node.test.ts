import { describe, it, expect } from "vitest";

import { buildFixture } from "./fixtures/build-fixture.js";
import {
  SCHEMA,
  BehavioralOutputDriverElement,
  BehavioralOutputDriverTriStateElement,
} from "../behavioral-output-driver.js";
import type { ComponentRegistry, StandaloneComponentDefinition } from "../../../core/registry.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../element.js";

// Slot index resolved by name — never imported as a raw constant.
const SLOT_DRIVE_V = SCHEMA.indexOf.get("DRIVE_V")!;

type Fixture = ReturnType<typeof buildFixture>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function ceByLabel(fix: Fixture, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

function findAnalogElementByLabel(fix: Fixture, label: string): AnalogElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    if (fix.elementLabels.get(i) === label) return fix.circuit.elements[i]!;
  }
  throw new Error(`AnalogElement with label '${label}' not found`);
}

// ---------------------------------------------------------------------------
// Thin CircuitElement factory helpers
//
// BehavioralOutputDriver(TriState) are internalOnly — facade.build() resolves
// only StandaloneComponentDefinitions. We register thin wrappers in the build
// callback under test-only names so the same AnalogElement classes are exercised
// without changing any production definition.
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
  return { label, direction, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" as const };
}

const NON_TRISTATE_PIN_DECLS = [
  { label: "pos",  direction: PinDirection.OUTPUT },
  { label: "neg",  direction: PinDirection.INPUT  },
  { label: "ctrl", direction: PinDirection.INPUT  },
];

const TRISTATE_PIN_DECLS = [
  { label: "pos",  direction: PinDirection.OUTPUT },
  { label: "neg",  direction: PinDirection.INPUT  },
  { label: "ctrl", direction: PinDirection.INPUT  },
  { label: "en",   direction: PinDirection.INPUT  },
];

function buildNonTriStateWrapperDef(): StandaloneComponentDefinition {
  return {
    name: "_TestBehavioralOutputDriver",
    typeId: -1,
    pinLayout: NON_TRISTATE_PIN_DECLS.map(p => makePinDecl(p.label, p.direction)),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    models: {},
    defaultModel: "default",
    factory: (props: PropertyBag): CircuitElement =>
      makeTestCircuitElement("_TestBehavioralOutputDriver", props, NON_TRISTATE_PIN_DECLS),
    modelRegistry: {
      default: {
        kind: "inline",
        paramDefs: [
          { key: "vOH",  default: 5 },
          { key: "vOL",  default: 0 },
          { key: "rOut", default: 100 },
        ],
        params: { vOH: 5, vOL: 0, rOut: 100 },
        branchCount: 0,
        factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag): AnalogElement =>
          new BehavioralOutputDriverElement(pinNodes, props),
      },
    },
  };
}

function buildTriStateWrapperDef(): StandaloneComponentDefinition {
  return {
    name: "_TestBehavioralOutputDriverTriState",
    typeId: -1,
    pinLayout: TRISTATE_PIN_DECLS.map(p => makePinDecl(p.label, p.direction)),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    models: {},
    defaultModel: "default",
    factory: (props: PropertyBag): CircuitElement =>
      makeTestCircuitElement("_TestBehavioralOutputDriverTriState", props, TRISTATE_PIN_DECLS),
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
// 3-port (non-tri-state) fixture builder
// ---------------------------------------------------------------------------

function buildNonTriState(
  vCtrl: number,
  rLoad: number,
  rOut = 100,
  vOH = 5,
  vOL = 0,
) {
  return (registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    registry.register(buildNonTriStateWrapperDef());
    return facade.build({
      components: [
        { id: "vsCtrl", type: "DcVoltageSource", props: { label: "vsCtrl", voltage: vCtrl } },
        { id: "drv",    type: "_TestBehavioralOutputDriver",
          props: { label: "drv", model: "default", vOH, vOL, rOut } },
        { id: "rLoad",  type: "Resistor", props: { label: "rLoad", resistance: rLoad } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsCtrl:pos", "drv:ctrl"],
        ["vsCtrl:neg", "gnd:out"],
        ["drv:neg",    "gnd:out"],
        ["drv:pos",    "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// 4-port (tri-state) fixture builder
// ---------------------------------------------------------------------------

function buildTriState(
  vCtrl: number,
  vEn: number,
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
        { id: "drv",    type: "_TestBehavioralOutputDriverTriState",
          props: { label: "drv", model: "default", vOH, vOL, rOut, rHiZ } },
        { id: "rLoad",  type: "Resistor", props: { label: "rLoad", resistance: rLoad } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsCtrl:pos", "drv:ctrl"],
        ["vsCtrl:neg", "gnd:out"],
        ["vsEn:pos",   "drv:en"],
        ["vsEn:neg",   "gnd:out"],
        ["drv:neg",    "gnd:out"],
        ["drv:pos",    "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// 3-port tests
// ---------------------------------------------------------------------------

describe("non-tri-state BehavioralOutputDriverElement (3-port)", () => {
  it("non-tri-state vCtrl high stamps vOH", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    const fix = buildFixture({ build: buildNonTriState(vOH + 1, rLoad, rOut, vOH, vOL) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    const expected = vOH * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("non-tri-state vCtrl low stamps vOL", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    const fix = buildFixture({ build: buildNonTriState(vOL - 1, rLoad, rOut, vOH, vOL) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    const expected = vOL * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("non-tri-state vCtrl at midpoint resolves to vOL (strict-greater threshold)", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    // ctrl exactly at (vOH + vOL) / 2 = 2.5 V — not strictly greater, so vOL
    const fix = buildFixture({ build: buildNonTriState((vOH + vOL) / 2, rLoad, rOut, vOH, vOL) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    const expected = vOL * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("hot-load rOut changes Norton conductance on next step", () => {
    const vOH = 5, vOL = 0, rOut1 = 100, rLoad = 100;
    const fix = buildFixture({ build: buildNonTriState(vOH + 1, rLoad, rOut1, vOH, vOL) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    expect(fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode))
      .toBeCloseTo(vOH * rLoad / (rLoad + rOut1), 6);

    const drvEl = ceByLabel(fix, "drv");
    const rOut2 = 1;
    fix.coordinator.setComponentProperty(drvEl, "rOut", rOut2);
    fix.coordinator.step();

    const vAfter = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    expect(vAfter).toBeCloseTo(vOH * rLoad / (rLoad + rOut2), 6);
  });

  it("hot-load vOH retargets Norton on next step", () => {
    const vOH1 = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    const fix = buildFixture({ build: buildNonTriState(vOH1 + 1, rLoad, rOut, vOH1, vOL) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    expect(fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode))
      .toBeCloseTo(vOH1 * rLoad / (rLoad + rOut), 6);

    const drvEl = ceByLabel(fix, "drv");
    const vOH2 = 3;
    fix.coordinator.setComponentProperty(drvEl, "vOH", vOH2);
    fix.coordinator.step();

    const vAfter = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    expect(vAfter).toBeCloseTo(vOH2 * rLoad / (rLoad + rOut), 6);
  });
});

// ---------------------------------------------------------------------------
// 4-port tests
// ---------------------------------------------------------------------------

describe("tri-state BehavioralOutputDriverTriStateElement (4-port)", () => {
  it("tri-state vEn high vCtrl high stamps vOH", () => {
    const vOH = 5, vOL = 0, rLoad = 1_000_000, rOut = 100, rHiZ = 1e9;
    const fix = buildFixture({ build: buildTriState(vOH, vOH, rLoad, rOut, vOH, vOL, rHiZ) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode);
    expect(vOut).toBeCloseTo(vOH * rLoad / (rLoad + rOut), 6);
  });

  it("tri-state vEn low collapses to high-Z", () => {
    const vOH = 5, vOL = 0, rLoad = 1000, rOut = 100, rHiZ = 1e9;
    // en is low → high-Z stamp; rLoad pull-down to gnd
    // Bound: |vOut| < vOH * (1/rHiZ) * rLoad = 5e-6 V
    const fix = buildFixture({ build: buildTriState(vOH, vOL, rLoad, rOut, vOH, vOL, rHiZ) });

    const posNode = nodeOf(fix, "drv:pos");
    const negNode = nodeOf(fix, "drv:neg");
    const vOut = Math.abs(fix.engine.getNodeVoltage(posNode) - fix.engine.getNodeVoltage(negNode));
    const bound = vOH * (1 / rHiZ) * rLoad;
    expect(vOut).toBeLessThan(bound + 1e-9);
  });

  it("DRIVE_V slot reflects enabled+target post-step", () => {
    const vOH = 5, vOL = 0, rLoad = 1_000_000, rOut = 100, rHiZ = 1e9;

    // en LOW → DRIVE_V slot = 0
    const fixDisabled = buildFixture({ build: buildTriState(vOH, vOL, rLoad, rOut, vOH, vOL, rHiZ) });
    const drvDisabled = findAnalogElementByLabel(fixDisabled, "drv");
    const slotDisabled = fixDisabled.pool.state1[drvDisabled._stateBase + SLOT_DRIVE_V];
    expect(slotDisabled).toBe(0);

    // en HIGH, ctrl HIGH → DRIVE_V slot = vOH
    const fixEnabled = buildFixture({ build: buildTriState(vOH, vOH, rLoad, rOut, vOH, vOL, rHiZ) });
    const drvEnabled = findAnalogElementByLabel(fixEnabled, "drv");
    const slotEnabled = fixEnabled.pool.state1[drvEnabled._stateBase + SLOT_DRIVE_V];
    expect(slotEnabled).toBeCloseTo(vOH, 9);
  });
});