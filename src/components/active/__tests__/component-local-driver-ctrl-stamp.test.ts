/**
 * Ctrl-stamp tests for Wave 4.6 component-local driver leaves:
 *   - ComparatorDriverElement     (single ctrl_out, open-collector)
 *   - ComparatorPushPullDriver    (single ctrl_out, push-pull)
 *   - Timer555LatchDriverElement  (single ctrl_out inside 555-timer latch)
 *   - ADCDriverElement            (ctrl_d_0..ctrl_d_{N-1})
 *
 * Tier: T1 (buildFixture, headless).
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

const VOH = 5.0;

function buildComparatorOCFixture(vPlus: number, vMinus: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "cmp",    type: "VoltageComparator", props: { label: "cmp", model: "open-collector", vOH: VOH, vOL: 0 } },
        { id: "vsPlus", type: "DcVoltageSource",   props: { voltage: vPlus } },
        { id: "vsMinus",type: "DcVoltageSource",   props: { voltage: vMinus } },
        { id: "vsVcc",  type: "DcVoltageSource",   props: { voltage: VOH } },
        { id: "rPull",  type: "Resistor",          props: { resistance: 10000 } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsPlus:pos",  "cmp:in+"],
        ["vsMinus:pos", "cmp:in-"],
        ["vsVcc:pos",   "rPull:pos"],
        ["rPull:neg",   "cmp:out"],
        ["vsPlus:neg",  "gnd:out"],
        ["vsMinus:neg", "gnd:out"],
        ["vsVcc:neg",   "gnd:out"],
      ],
    }),
  });
}

function buildComparatorPPFixture(vPlus: number, vMinus: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "cmp",    type: "VoltageComparator", props: { label: "cmp", model: "push-pull", vOH: VOH, vOL: 0 } },
        { id: "vsPlus", type: "DcVoltageSource",   props: { voltage: vPlus } },
        { id: "vsMinus",type: "DcVoltageSource",   props: { voltage: vMinus } },
        { id: "rLoad",  type: "Resistor",          props: { resistance: 10000 } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsPlus:pos",  "cmp:in+"],
        ["vsMinus:pos", "cmp:in-"],
        ["cmp:out",     "rLoad:pos"],
        ["rLoad:neg",   "gnd:out"],
        ["vsPlus:neg",  "gnd:out"],
        ["vsMinus:neg", "gnd:out"],
      ],
    }),
  });
}

function buildTimer555Fixture(vTrig: number, vThr: number) {
  const VCC = 5.0;
  const VCTRL = VCC * 2 / 3; // Standard CTRL bias: 2/3 VCC restores R-divider midpoints
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "t555",   type: "Timer555",        props: { label: "t555" } },
        { id: "vsVcc",  type: "DcVoltageSource", props: { voltage: VCC } },
        { id: "vsRst",  type: "DcVoltageSource", props: { voltage: VCC } },
        { id: "vsTrig", type: "DcVoltageSource", props: { voltage: vTrig } },
        { id: "vsThr",  type: "DcVoltageSource", props: { voltage: vThr } },
        { id: "vsCtrl", type: "DcVoltageSource", props: { voltage: VCTRL } },
        { id: "rLoad",  type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsVcc:pos",  "t555:VCC"],
        ["vsRst:pos",  "t555:RST"],
        ["vsTrig:pos", "t555:TRIG"],
        ["vsThr:pos",  "t555:THR"],
        ["vsCtrl:pos", "t555:CTRL"],
        ["t555:OUT",   "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
        ["vsVcc:neg",  "gnd:out"],
        ["vsRst:neg",  "gnd:out"],
        ["vsTrig:neg", "gnd:out"],
        ["vsThr:neg",  "gnd:out"],
        ["vsCtrl:neg", "gnd:out"],
        ["t555:GND",   "gnd:out"],
        ["t555:DIS",   "gnd:out"],
      ],
    }),
  });
}

function buildADCFixture(vIn: number, vClk: number) {
  const VREF = 5.0;
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "adc",   type: "ADC",             props: { label: "adc", bits: 4, sar: 0 } },
        { id: "vsIn",  type: "DcVoltageSource", props: { voltage: vIn } },
        { id: "vsRef", type: "DcVoltageSource", props: { voltage: VREF } },
        { id: "vsClk", type: "DcVoltageSource", props: { voltage: vClk } },
        { id: "rD0",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rD1",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rD2",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rD3",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",   "adc:VIN"],
        ["vsRef:pos",  "adc:VREF"],
        ["vsClk:pos",  "adc:CLK"],
        ["adc:D0",     "rD0:pos"],
        ["adc:D1",     "rD1:pos"],
        ["adc:D2",     "rD2:pos"],
        ["adc:D3",     "rD3:pos"],
        ["rD0:neg",    "gnd:out"],
        ["rD1:neg",    "gnd:out"],
        ["rD2:neg",    "gnd:out"],
        ["rD3:neg",    "gnd:out"],
        ["vsIn:neg",   "gnd:out"],
        ["vsRef:neg",  "gnd:out"],
        ["vsClk:neg",  "gnd:out"],
        ["adc:GND",    "gnd:out"],
      ],
    }),
  });
}

describe("ComparatorDriver (open-collector) — ctrl_out Norton stamp (Cat 2 analytical)", () => {
  it("stamps vOH at out when in+ is above in- (not sinking: pull-up holds line high)", () => {
    const fix = buildComparatorOCFixture(4.0, 2.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    const vOut = signals["cmp:out"];
    expect(vOut).toBeGreaterThan(VOH * 0.8);
  });

  it("stamps vOL at out when in+ is below in- (asserted: sinking pulls line low)", () => {
    const fix = buildComparatorOCFixture(1.0, 3.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    const vOut = signals["cmp:out"];
    expect(vOut).toBeLessThan(1.0);
  });
});

describe("ComparatorPushPullDriver — ctrl_out Norton stamp (Cat 2 analytical)", () => {
  it("stamps vOH at out when in+ is above in- (push-pull drives HIGH)", () => {
    const fix = buildComparatorPPFixture(4.0, 2.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    const vOut = signals["cmp:out"];
    expect(vOut).toBeGreaterThan(VOH * 0.8);
    expect(vOut).toBeLessThan(VOH * 1.1);
  });

  it("stamps vOL at out when in+ is below in- (push-pull drives LOW)", () => {
    const fix = buildComparatorPPFixture(1.0, 3.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    const vOut = signals["cmp:out"];
    expect(vOut).toBeLessThan(1.0);
  });
});

describe("Timer555LatchDriver — ctrl_out Norton stamp via Timer555 composite (Cat 2 analytical)", () => {
  it("timer output is HIGH when TRIG is pulled low (set condition)", () => {
    const fix = buildTimer555Fixture(0.5, 1.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    const vOut = signals["t555:OUT"];
    expect(vOut).toBeGreaterThan(2.0);
  });

  it("timer output is LOW when THR is pulled high (reset condition)", () => {
    const fix = buildTimer555Fixture(2.5, 4.5);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    const vOut = signals["t555:OUT"];
    expect(vOut).toBeLessThan(2.0);
  });
});

describe("ADCDriver — ctrl_d_i Norton stamp via ADC composite (Cat 2 analytical)", () => {
  it("D0..D3 all LOW when vIn = 0 (code=0, all bits 0)", () => {
    const fix = buildADCFixture(0.0, 5.0);
    fix.coordinator.step();
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    expect(signals["adc:D0"]).toBeLessThan(1.0);
    expect(signals["adc:D1"]).toBeLessThan(1.0);
    expect(signals["adc:D2"]).toBeLessThan(1.0);
    expect(signals["adc:D3"]).toBeLessThan(1.0);
  });

  it("D3 HIGH and D0..D2 LOW when vIn = VREF*0.5 (code=8 for 4-bit: 0b1000)", () => {
    const fix = buildADCFixture(2.5, 5.0);
    fix.coordinator.step();
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    expect(signals["adc:D3"]).toBeGreaterThan(3.0);
    expect(signals["adc:D2"]).toBeLessThan(1.0);
    expect(signals["adc:D1"]).toBeLessThan(1.0);
    expect(signals["adc:D0"]).toBeLessThan(1.0);
  });

  it("D0..D3 all HIGH when vIn >= VREF (code=15 for 4-bit: 0b1111)", () => {
    const fix = buildADCFixture(5.0, 5.0);
    fix.coordinator.step();
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    expect(signals["adc:D0"]).toBeGreaterThan(3.0);
    expect(signals["adc:D1"]).toBeGreaterThan(3.0);
    expect(signals["adc:D2"]).toBeGreaterThan(3.0);
    expect(signals["adc:D3"]).toBeGreaterThan(3.0);
  });
});