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

// Input drive voltages (rail levels applied to DC source inputs).
const VDD = 5.0;
const GND = 0.0;
// MID is well above the 0.5 V driver threshold, so under the {0,1}
// contract it is classified as HIGH — same as VDD. There is no
// indeterminate-hold band any more (see and-driver.ts).
const MID = 1.5;
// Expected ctrl_out voltages — drivers stamp normalized {0, 1} V.
const HI = 1.0;
const LO = 0.0;
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
  it("stamps HI at ctrl_out when all inputs are high (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralAndDriverElement, HI);
  });
  it("stamps LO at ctrl_out when any input is low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("And", GND, GND) });
    assertCtrlOutV(fix, BehavioralAndDriverElement, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): AND → HI", () => {
    const fix = buildFixture({ build: build2InputGate("And", MID, MID) });
    assertCtrlOutV(fix, BehavioralAndDriverElement, HI);
  });
});

describe("BehavioralOrDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when any input is high (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("Or", VDD, GND) });
    assertCtrlOutV(fix, BehavioralOrDriverElement, HI);
  });
  it("stamps LO at ctrl_out when all inputs are low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("Or", GND, GND) });
    assertCtrlOutV(fix, BehavioralOrDriverElement, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): OR → HI", () => {
    const fix = buildFixture({ build: build2InputGate("Or", MID, MID) });
    assertCtrlOutV(fix, BehavioralOrDriverElement, HI);
  });
});

describe("BehavioralNandDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps LO at ctrl_out when all inputs are high (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralNandDriverElement, LO);
  });
  it("stamps HI at ctrl_out when any input is low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", GND, GND) });
    assertCtrlOutV(fix, BehavioralNandDriverElement, HI);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): NAND → LO", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", MID, MID) });
    assertCtrlOutV(fix, BehavioralNandDriverElement, LO);
  });
});

describe("BehavioralNorDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps LO at ctrl_out when any input is high (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", VDD, GND) });
    assertCtrlOutV(fix, BehavioralNorDriverElement, LO);
  });
  it("stamps HI at ctrl_out when all inputs are low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", GND, GND) });
    assertCtrlOutV(fix, BehavioralNorDriverElement, HI);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): NOR → LO", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", MID, MID) });
    assertCtrlOutV(fix, BehavioralNorDriverElement, LO);
  });
});

describe("BehavioralXorDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when inputs differ (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", VDD, GND) });
    assertCtrlOutV(fix, BehavioralXorDriverElement, HI);
  });
  it("stamps LO at ctrl_out when inputs are equal (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralXorDriverElement, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): XOR → LO (equal)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", MID, MID) });
    assertCtrlOutV(fix, BehavioralXorDriverElement, LO);
  });
});

describe("BehavioralXnorDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when inputs are equal (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", VDD, VDD) });
    assertCtrlOutV(fix, BehavioralXnorDriverElement, HI);
  });
  it("stamps LO at ctrl_out when inputs differ (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", VDD, GND) });
    assertCtrlOutV(fix, BehavioralXnorDriverElement, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): XNOR → HI (equal)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", MID, MID) });
    assertCtrlOutV(fix, BehavioralXnorDriverElement, HI);
  });
});

describe("BehavioralNotDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps LO at ctrl_out when input is high (in=VDD)", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "in", VDD) });
    assertCtrlOutV(fix, BehavioralNotDriverElement, LO);
  });
  it("stamps HI at ctrl_out when input is low (in=GND)", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "in", GND) });
    assertCtrlOutV(fix, BehavioralNotDriverElement, HI);
  });
  it("treats above-threshold input as HIGH (in=MID): NOT → LO", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "in", MID) });
    assertCtrlOutV(fix, BehavioralNotDriverElement, LO);
  });
});

describe("BehavioralBufDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when input is high (In_1=VDD)", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", VDD) });
    assertCtrlOutV(fix, BehavioralBufDriverElement, HI);
  });
  it("stamps LO at ctrl_out when input is low (In_1=GND)", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", GND) });
    assertCtrlOutV(fix, BehavioralBufDriverElement, LO);
  });
  it("treats above-threshold input as HIGH (In_1=MID): BUF → HI", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", MID) });
    assertCtrlOutV(fix, BehavioralBufDriverElement, HI);
  });
});
