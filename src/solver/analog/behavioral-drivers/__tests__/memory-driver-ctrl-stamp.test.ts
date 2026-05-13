import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import { BehavioralCounterDriverElement } from "../counter-driver.js";
import { BehavioralCounterPresetDriverElement } from "../counter-preset-driver.js";
import { BehavioralRegisterDriverElement } from "../register-driver.js";
import type { AnalogElement } from "../../element.js";

const VOH = 5.0;
const VOL = 0.0;

type AnyDriverClass =
  | typeof BehavioralCounterDriverElement
  | typeof BehavioralCounterPresetDriverElement
  | typeof BehavioralRegisterDriverElement;

function findDriverElement(
  fix: ReturnType<typeof buildFixture>,
  DriverCls: AnyDriverClass,
): AnalogElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof DriverCls) return el;
  }
  throw new Error("No " + DriverCls.name + " found in compiled circuit");
}

function getCtrlV(
  fix: ReturnType<typeof buildFixture>,
  el: AnalogElement,
  ctrlPin: string,
): number {
  const ctrlNode = el.pinNodes.get(ctrlPin);
  const gndNode  = el.pinNodes.get("gnd");
  if (ctrlNode === undefined) throw new Error(ctrlPin + " pin not found on driver");
  if (gndNode  === undefined) throw new Error("gnd pin not found on driver");
  return fix.engine.getNodeVoltage(ctrlNode) - fix.engine.getNodeVoltage(gndNode);
}

function pulseClock(
  fix: ReturnType<typeof buildFixture>,
  clkLabel: string,
): void {
  fix.facade.setSignal(fix.coordinator, clkLabel, VOL);
  fix.coordinator.step();
  fix.facade.setSignal(fix.coordinator, clkLabel, VOH);
  fix.coordinator.step();
  fix.facade.setSignal(fix.coordinator, clkLabel, VOL);
  fix.coordinator.step();
}

// ===========================================================================
// BehavioralCounterDriver (bitWidth=1)
//
// Counter with bitWidth=1: one ctrl_bit_0 output and ctrl_ovf.
// Each driven by exactly one Norton source — no packed-bus contention.
// ===========================================================================

function buildCounterFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsEN",  type: "DcVoltageSource", props: { label: "vsEN",  voltage: VOL } },
          { id: "vsC",   type: "DcVoltageSource", props: { label: "vsC",   voltage: VOL } },
          { id: "vsCLR", type: "DcVoltageSource", props: { label: "vsCLR", voltage: VOL } },
          { id: "ctr",   type: "Counter",         props: { label: "ctr",   bitWidth: 1, model: "behavioral" } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsEN:pos",  "ctr:en"],
          ["vsC:pos",   "ctr:C"],
          ["vsCLR:pos", "ctr:clr"],
          ["vsEN:neg",  "gnd:out"],
          ["vsC:neg",   "gnd:out"],
          ["vsCLR:neg", "gnd:out"],
        ],
      }),
  });
}

describe("BehavioralCounterDriver ctrl_bit_0 stamp (bitWidth=1)", () => {
  it("count=0 at reset: ctrl_bit_0=VOL, ctrl_ovf=VOL", () => {
    const fix = buildCounterFixture();
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);
    fix.coordinator.step();
    const el = findDriverElement(fix, BehavioralCounterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOL, 4);
    expect(getCtrlV(fix, el, "ctrl_ovf")).toBeCloseTo(VOL, 4);
  });

  it("count=1 after rising edge with en=1: ctrl_bit_0=VOH, ctrl_ovf=VOH (maxValue=1)", () => {
    const fix = buildCounterFixture();
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);
    pulseClock(fix, "vsC");
    const el = findDriverElement(fix, BehavioralCounterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOH, 4);
    expect(getCtrlV(fix, el, "ctrl_ovf")).toBeCloseTo(VOH, 4);
  });

  it("clr=1 on rising edge resets count to 0: ctrl_bit_0=VOL, ctrl_ovf=VOL", () => {
    const fix = buildCounterFixture();
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);
    pulseClock(fix, "vsC");
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOH);
    pulseClock(fix, "vsC");
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);
    const el = findDriverElement(fix, BehavioralCounterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOL, 4);
    expect(getCtrlV(fix, el, "ctrl_ovf")).toBeCloseTo(VOL, 4);
  });
});

// ===========================================================================
// BehavioralCounterPresetDriver (bitWidth=1)
//
// CounterPreset with bitWidth=1: one ctrl_bit_0 output and ctrl_ovf.
// ===========================================================================

function buildCounterPresetFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsEN",  type: "DcVoltageSource", props: { label: "vsEN",  voltage: VOL } },
          { id: "vsC",   type: "DcVoltageSource", props: { label: "vsC",   voltage: VOL } },
          { id: "vsDIR", type: "DcVoltageSource", props: { label: "vsDIR", voltage: VOL } },
          { id: "vsIN",  type: "DcVoltageSource", props: { label: "vsIN",  voltage: VOL } },
          { id: "vsLD",  type: "DcVoltageSource", props: { label: "vsLD",  voltage: VOL } },
          { id: "vsCLR", type: "DcVoltageSource", props: { label: "vsCLR", voltage: VOL } },
          { id: "ctp",   type: "CounterPreset",   props: { label: "ctp",   bitWidth: 1, model: "behavioral" } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsEN:pos",  "ctp:en"],
          ["vsC:pos",   "ctp:C"],
          ["vsDIR:pos", "ctp:dir"],
          ["vsIN:pos",  "ctp:in"],
          ["vsLD:pos",  "ctp:ld"],
          ["vsCLR:pos", "ctp:clr"],
          ["vsEN:neg",  "gnd:out"],
          ["vsC:neg",   "gnd:out"],
          ["vsDIR:neg", "gnd:out"],
          ["vsIN:neg",  "gnd:out"],
          ["vsLD:neg",  "gnd:out"],
          ["vsCLR:neg", "gnd:out"],
        ],
      }),
  });
}

describe("BehavioralCounterPresetDriver ctrl_bit_0 stamp (bitWidth=1)", () => {
  it("count=0 at reset with en=1, dir=0: ctrl_bit_0=VOL, ctrl_ovf=VOL", () => {
    const fix = buildCounterPresetFixture();
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsLD", VOL);
    fix.coordinator.step();
    const el = findDriverElement(fix, BehavioralCounterPresetDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOL, 4);
    expect(getCtrlV(fix, el, "ctrl_ovf")).toBeCloseTo(VOL, 4);
  });

  it("count=1 after rising edge with en=1, dir=0: ctrl_bit_0=VOH, ctrl_ovf=VOH", () => {
    const fix = buildCounterPresetFixture();
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsLD", VOL);
    pulseClock(fix, "vsC");
    const el = findDriverElement(fix, BehavioralCounterPresetDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOH, 4);
    expect(getCtrlV(fix, el, "ctrl_ovf")).toBeCloseTo(VOH, 4);
  });

  it("dir=1 (down) from count=1: after one down-count, count=0, ctrl_ovf=VOH", () => {
    const fix = buildCounterPresetFixture();
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsLD", VOL);
    // Count up once: count=1, ctrl_bit_0=VOH
    pulseClock(fix, "vsC");
    // Switch to down-count
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOH);
    // Count down once: count=0, ctrl_ovf=VOH (underflow on next down-count would set ovf)
    pulseClock(fix, "vsC");
    const el = findDriverElement(fix, BehavioralCounterPresetDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOL, 4);
    expect(getCtrlV(fix, el, "ctrl_ovf")).toBeCloseTo(VOH, 4);
  });
});

// ===========================================================================
// BehavioralRegisterDriver (bitWidth=1)
//
// Register with bitWidth=1: one ctrl_bit_0 output pin.
// ===========================================================================

function buildRegisterFixture() {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsD",  type: "DcVoltageSource", props: { label: "vsD",  voltage: VOL } },
          { id: "vsC",  type: "DcVoltageSource", props: { label: "vsC",  voltage: VOL } },
          { id: "vsEN", type: "DcVoltageSource", props: { label: "vsEN", voltage: VOL } },
          { id: "reg",  type: "Register",        props: { label: "reg",  bitWidth: 1, model: "behavioral" } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vsD:pos",  "reg:D"],
          ["vsC:pos",  "reg:C"],
          ["vsEN:pos", "reg:en"],
          ["vsD:neg",  "gnd:out"],
          ["vsC:neg",  "gnd:out"],
          ["vsEN:neg", "gnd:out"],
        ],
      }),
  });
}

describe("BehavioralRegisterDriver ctrl_bit_0 stamp (bitWidth=1)", () => {
  it("initial state stored=0: ctrl_bit_0=VOL", () => {
    const fix = buildRegisterFixture();
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsD", VOL);
    fix.coordinator.step();
    const el = findDriverElement(fix, BehavioralRegisterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOL, 4);
  });

  it("stores D=1 on rising edge with en=1: ctrl_bit_0=VOH", () => {
    const fix = buildRegisterFixture();
    fix.facade.setSignal(fix.coordinator, "vsD", VOH);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    pulseClock(fix, "vsC");
    const el = findDriverElement(fix, BehavioralRegisterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOH, 4);
  });

  it("en=0: rising clock does not latch D=1; stored value holds at 0 => ctrl_bit_0=VOL", () => {
    const fix = buildRegisterFixture();
    fix.facade.setSignal(fix.coordinator, "vsD", VOH);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOL);
    pulseClock(fix, "vsC");
    const el = findDriverElement(fix, BehavioralRegisterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_bit_0")).toBeCloseTo(VOL, 4);
  });
});
