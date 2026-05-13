import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import {
  buildDigitalOutputPinUnloadedNetlist,
} from "../digital-output-pin-unloaded.js";
import type { ComponentRegistry, StandaloneComponentDefinition } from "../../../core/registry.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import { PropertyBag } from "../../../core/properties.js";

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

const UNLOADED_PIN_DECLS = [
  { label: "node", direction: PinDirection.OUTPUT },
  { label: "gnd",  direction: PinDirection.OUTPUT },
  { label: "ctrl", direction: PinDirection.INPUT  },
];

function buildUnloadedWrapperDef(): StandaloneComponentDefinition {
  return {
    name: "_TestDigitalOutputPinUnloaded",
    typeId: -1,
    pinLayout: UNLOADED_PIN_DECLS.map(p => makePinDecl(p.label, p.direction)),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "",
    models: {},
    defaultModel: "default",
    factory: (props: PropertyBag): CircuitElement =>
      makeTestCircuitElement("_TestDigitalOutputPinUnloaded", props, UNLOADED_PIN_DECLS),
    modelRegistry: {
      default: {
        kind: "netlist",
        netlist: buildDigitalOutputPinUnloadedNetlist,
        paramDefs: [
          { key: "rOut", default: 100 },
          { key: "vOH",  default: 5 },
          { key: "vOL",  default: 0 },
        ],
        params: { rOut: 100, vOH: 5, vOL: 0 },
      },
    },
  };
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function buildUnloaded(vCtrl: number, rLoad: number, vOH = 5, vOL = 0, rOut = 100) {
  return (registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit => {
    registry.register(buildUnloadedWrapperDef());
    return facade.build({
      components: [
        { id: "vsCtrl", type: "DcVoltageSource", props: { label: "vsCtrl", voltage: vCtrl } },
        { id: "pin",    type: "_TestDigitalOutputPinUnloaded",
          props: { label: "pin", model: "default", vOH, vOL, rOut } },
        { id: "rLoad",  type: "Resistor", props: { label: "rLoad", resistance: rLoad } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsCtrl:pos", "pin:ctrl"],
        ["vsCtrl:neg", "gnd:out"],
        ["pin:gnd",    "gnd:out"],
        ["pin:node",   "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
      ],
    });
  };
}

describe("DigitalOutputPinUnloaded (3-port composite)", () => {
  it("ctrl=1 (normalized high) produces vOH at node", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    const fix = buildFixture({ build: buildUnloaded(1, rLoad, vOH, vOL, rOut) });

    const nodeN = nodeOf(fix, "pin:node");
    const gndN  = nodeOf(fix, "pin:gnd");
    const vOut = fix.engine.getNodeVoltage(nodeN) - fix.engine.getNodeVoltage(gndN);
    const expected = vOH * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("ctrl=0 (normalized low) produces vOL at node", () => {
    const vOH = 5, vOL = 0, rOut = 100, rLoad = 1_000_000;
    const fix = buildFixture({ build: buildUnloaded(0, rLoad, vOH, vOL, rOut) });

    const nodeN = nodeOf(fix, "pin:node");
    const gndN  = nodeOf(fix, "pin:gnd");
    const vOut = fix.engine.getNodeVoltage(nodeN) - fix.engine.getNodeVoltage(gndN);
    const expected = vOL * rLoad / (rLoad + rOut);
    expect(vOut).toBeCloseTo(expected, 6);
  });
});
