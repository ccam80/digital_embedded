import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { Circuit } from "../../../../core/circuit.js";
import { BehavioralAndDriverElement }  from "../and-driver.js";
import { BehavioralOrDriverElement }   from "../or-driver.js";
import { BehavioralNandDriverElement } from "../nand-driver.js";
import { BehavioralNorDriverElement }  from "../nor-driver.js";
import { BehavioralXorDriverElement }  from "../xor-driver.js";
import { BehavioralXnorDriverElement } from "../xnor-driver.js";
import { BehavioralNotDriverElement }  from "../not-driver.js";
import { BehavioralBufDriverElement }  from "../buf-driver.js";
import type { AnalogElement } from "../../element.js";

const VDD = 5.0;
const GND = 0.0;
const MID = 1.5;
const LOAD_R = 1_000_000;

type DriverClass =
  | typeof BehavioralAndDriverElement
  | typeof BehavioralOrDriverElement
  | typeof BehavioralNandDriverElement
  | typeof BehavioralNorDriverElement
  | typeof BehavioralXorDriverElement
  | typeof BehavioralXnorDriverElement
  | typeof BehavioralNotDriverElement
  | typeof BehavioralBufDriverElement;

function findDriverElement(
  fix: ReturnType<typeof buildFixture>,
  DriverCls: DriverClass,
): AnalogElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof DriverCls) return el;
  }
  throw new Error("No " + DriverCls.name + " found in compiled circuit");
}

function build2InputGate(gateType: string, vA: number, vB: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit =>
    facade.build({
      components: [
        { id: "vsA",   type: "DcVoltageSource", props: { label: "vsA",   voltage: vA } },
        { id: "vsB",   type: "DcVoltageSource", props: { label: "vsB",   voltage: vB } },
        { id: "gate",  type: gateType,          props: { label: "gate",  model: "behavioral", inputCount: 2 } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsA:pos",   "gate:In_1"],
        ["vsB:pos",   "gate:In_2"],
        ["gate:out",  "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsA:neg",   "gnd:out"],
        ["vsB:neg",   "gnd:out"],
      ],
    });
}

function build1InputGate(gateType: string, inputPin: string, vIn: number) {
  return (_registry: ComponentRegistry, facade: DefaultSimulatorFacade): Circuit =>
    facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn",  voltage: vIn } },
        { id: "gate",  type: gateType,          props: { label: "gate",  model: "behavioral" } },
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",  "gate:" + inputPin],
        ["gate:out",  "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsIn:neg",  "gnd:out"],
      ],
    });
}

function assertCtrlOutV(
  fix: ReturnType<typeof buildFixture>,
  DriverCls: DriverClass,
  expected: number,
  precision = 4,
): void {
  const el = findDriverElement(fix, DriverCls);
  const ctrlOutNode = el.pinNodes.get("ctrl_out");
  const gndNode     = el.pinNodes.get("gnd");
  if (ctrlOutNode === undefined) throw new Error("ctrl_out pin not found on driver");
  if (gndNode === undefined)     throw new Error("gnd pin not found on driver");
  const vCtrl = fix.engine.getNodeVoltage(ctrlOutNode) - fix.engine.getNodeVoltage(gndNode);
  expect(vCtrl).toBeCloseTo(expected, precision);
}

describe("BehavioralAndDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOH at ctrl_out when all inputs are high (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralAndDriverElement, VDD);
  });
  it("stamps vOL at ctrl_out when any input is low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("And", GND, GND) });
    assertCtrlOutV(fix, BehavioralAndDriverElement, GND);
  });
  it("holds prior target at ctrl_out for indeterminate input (A=MID, B=MID)", () => {
    const fix = buildFixture({ build: build2InputGate("And", MID, MID) });
    assertCtrlOutV(fix, BehavioralAndDriverElement, GND);
  });
});

describe("BehavioralOrDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOH at ctrl_out when any input is high (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("Or", VDD, GND) });
    assertCtrlOutV(fix, BehavioralOrDriverElement, VDD);
  });
  it("stamps vOL at ctrl_out when all inputs are low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("Or", GND, GND) });
    assertCtrlOutV(fix, BehavioralOrDriverElement, GND);
  });
  it("holds prior target at ctrl_out for indeterminate input (A=MID, B=MID)", () => {
    const fix = buildFixture({ build: build2InputGate("Or", MID, MID) });
    assertCtrlOutV(fix, BehavioralOrDriverElement, GND);
  });
});

describe("BehavioralNandDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOL at ctrl_out when all inputs are high (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralNandDriverElement, GND);
  });
  it("stamps vOH at ctrl_out when any input is low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", GND, GND) });
    assertCtrlOutV(fix, BehavioralNandDriverElement, VDD);
  });
  it("holds prior target at ctrl_out for indeterminate input (A=MID, B=MID)", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", MID, MID) });
    assertCtrlOutV(fix, BehavioralNandDriverElement, GND);
  });
});

describe("BehavioralNorDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOL at ctrl_out when any input is high (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", VDD, GND) });
    assertCtrlOutV(fix, BehavioralNorDriverElement, GND);
  });
  it("stamps vOH at ctrl_out when all inputs are low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", GND, GND) });
    assertCtrlOutV(fix, BehavioralNorDriverElement, VDD);
  });
  it("holds prior target at ctrl_out for indeterminate input (A=MID, B=MID)", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", MID, MID) });
    assertCtrlOutV(fix, BehavioralNorDriverElement, GND);
  });
});

describe("BehavioralXorDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOH at ctrl_out when inputs differ (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", VDD, GND) });
    assertCtrlOutV(fix, BehavioralXorDriverElement, VDD);
  });
  it("stamps vOL at ctrl_out when inputs are equal (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralXorDriverElement, GND);
  });
  it("holds prior target at ctrl_out for indeterminate input (A=MID, B=MID)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", MID, MID) });
    assertCtrlOutV(fix, BehavioralXorDriverElement, GND);
  });
});

describe("BehavioralXnorDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOH at ctrl_out when inputs are equal (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralXnorDriverElement, VDD);
  });
  it("stamps vOL at ctrl_out when inputs differ (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", VDD, GND) });
    assertCtrlOutV(fix, BehavioralXnorDriverElement, GND);
  });
  it("holds prior target at ctrl_out for indeterminate input (A=MID, B=MID)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", MID, MID) });
    assertCtrlOutV(fix, BehavioralXnorDriverElement, GND);
  });
});

describe("BehavioralNotDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOL at ctrl_out when input is high (in=VDD)", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "in", VDD) });
    assertCtrlOutV(fix, BehavioralNotDriverElement, GND);
  });
  it("stamps vOH at ctrl_out when input is low (in=GND)", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "in", GND) });
    assertCtrlOutV(fix, BehavioralNotDriverElement, VDD);
  });
  it("holds prior target at ctrl_out for indeterminate input (in=MID)", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "in", MID) });
    assertCtrlOutV(fix, BehavioralNotDriverElement, GND);
  });
});

describe("BehavioralBufDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps vOH at ctrl_out when input is high (In_1=VDD)", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", VDD) });
    assertCtrlOutV(fix, BehavioralBufDriverElement, VDD);
  });
  it("stamps vOL at ctrl_out when input is low (In_1=GND)", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", GND) });
    assertCtrlOutV(fix, BehavioralBufDriverElement, GND);
  });
  it("holds prior target at ctrl_out for indeterminate input (In_1=MID)", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", MID) });
    assertCtrlOutV(fix, BehavioralBufDriverElement, GND);
  });
});