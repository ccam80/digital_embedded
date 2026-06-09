import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { Circuit } from "../../../../core/circuit.js";
import { BIAnalogElement } from "../../../../components/active/bsource.js";
import type { AnalogElement } from "../../element.js";

// Input drive voltages (rail levels applied to DC source inputs).
const VDD = 5.0;
const GND = 0.0;
// MID sits above the CMOS input-high threshold vIH = 2.0 V (the digital input
// pin's classifier threshold), so it resolves to logic HIGH — same as VDD —
// while exercising a valid-HIGH level below the supply rail.
const MID = 3.0;
// Expected ctrl_out voltages — BehavioralLogic B-source stamps normalized {0, 1} V.
const HI = 1.0;
const LO = 0.0;
const LOAD_R = 1_000_000;

function findDriverElement(
  fix: ReturnType<typeof buildFixture>,
): AnalogElement {
  // The gate's truth-function driver and every digital input pin are all
  // BehavioralLogic B-sources (BIAnalogElement). They are distinguished by their
  // controllers: the gate drv reads the input result-nets r1..rN, while a pin
  // thresholder reads (in, vih, vil). Select the unique B-source carrying an
  // "r1" controller pin — the gate drv.
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof BIAnalogElement && el.pinNodes.has("r1")) return el;
  }
  throw new Error("No gate-driver BIAnalogElement (controller 'r1') found in compiled circuit");
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
  expected: number,
  precision = 4,
): void {
  const el = findDriverElement(fix);
  const ctrlOutNode = el.pinNodes.get("out-");
  const gndNode     = el.pinNodes.get("out+");
  if (ctrlOutNode === undefined) throw new Error("out- pin not found on BIAnalogElement");
  if (gndNode === undefined)     throw new Error("out+ pin not found on BIAnalogElement");
  const vCtrl = fix.engine.getNodeVoltage(ctrlOutNode) - fix.engine.getNodeVoltage(gndNode);
  expect(vCtrl).toBeCloseTo(expected, precision);
}

describe("BehavioralLogic AND ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when all inputs are high (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("And", VDD, VDD) });
    assertCtrlOutV(fix, HI);
  });
  it("stamps LO at ctrl_out when any input is low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("And", GND, GND) });
    assertCtrlOutV(fix, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): AND → HI", () => {
    const fix = buildFixture({ build: build2InputGate("And", MID, MID) });
    assertCtrlOutV(fix, HI);
  });
});

describe("BehavioralLogic OR ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when any input is high (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("Or", VDD, GND) });
    assertCtrlOutV(fix, HI);
  });
  it("stamps LO at ctrl_out when all inputs are low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("Or", GND, GND) });
    assertCtrlOutV(fix, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): OR → HI", () => {
    const fix = buildFixture({ build: build2InputGate("Or", MID, MID) });
    assertCtrlOutV(fix, HI);
  });
});

describe("BehavioralLogic NAND ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps LO at ctrl_out when all inputs are high (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", VDD, VDD) });
    assertCtrlOutV(fix, LO);
  });
  it("stamps HI at ctrl_out when any input is low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", GND, GND) });
    assertCtrlOutV(fix, HI);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): NAND → LO", () => {
    const fix = buildFixture({ build: build2InputGate("NAnd", MID, MID) });
    assertCtrlOutV(fix, LO);
  });
});

describe("BehavioralLogic NOR ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps LO at ctrl_out when any input is high (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", VDD, GND) });
    assertCtrlOutV(fix, LO);
  });
  it("stamps HI at ctrl_out when all inputs are low (A=GND, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", GND, GND) });
    assertCtrlOutV(fix, HI);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): NOR → LO", () => {
    const fix = buildFixture({ build: build2InputGate("NOr", MID, MID) });
    assertCtrlOutV(fix, LO);
  });
});

describe("BehavioralLogic XOR ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when inputs differ (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", VDD, GND) });
    assertCtrlOutV(fix, HI);
  });
  it("stamps LO at ctrl_out when inputs are equal (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", VDD, VDD) });
    assertCtrlOutV(fix, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): XOR → LO (equal)", () => {
    const fix = buildFixture({ build: build2InputGate("XOr", MID, MID) });
    assertCtrlOutV(fix, LO);
  });
});

describe("BehavioralLogic XNOR ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when inputs are equal (A=VDD, B=VDD)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", VDD, VDD) });
    assertCtrlOutV(fix, HI);
  });
  it("stamps LO at ctrl_out when inputs differ (A=VDD, B=GND)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", VDD, GND) });
    assertCtrlOutV(fix, LO);
  });
  it("treats above-threshold input as HIGH (A=MID, B=MID): XNOR → HI (equal)", () => {
    const fix = buildFixture({ build: build2InputGate("XNOr", MID, MID) });
    assertCtrlOutV(fix, HI);
  });
});

describe("BehavioralLogic NOT ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps LO at ctrl_out when input is high (In_1=VDD)", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "In_1", VDD) });
    assertCtrlOutV(fix, LO);
  });
  it("stamps HI at ctrl_out when input is low (In_1=GND)", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "In_1", GND) });
    assertCtrlOutV(fix, HI);
  });
  it("treats above-threshold input as HIGH (In_1=MID): NOT → LO", () => {
    const fix = buildFixture({ build: build1InputGate("Not", "In_1", MID) });
    assertCtrlOutV(fix, LO);
  });
});

describe("BehavioralLogic BUF ctrl_out stamp (Cat 2 DCOP)", () => {
  it("stamps HI at ctrl_out when input is high (In_1=VDD)", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", VDD) });
    assertCtrlOutV(fix, HI);
  });
  it("stamps LO at ctrl_out when input is low (In_1=GND)", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", GND) });
    assertCtrlOutV(fix, LO);
  });
  it("treats above-threshold input as HIGH (In_1=MID): BUF → HI", () => {
    const fix = buildFixture({ build: build1InputGate("Buf", "In_1", MID) });
    assertCtrlOutV(fix, HI);
  });
});
