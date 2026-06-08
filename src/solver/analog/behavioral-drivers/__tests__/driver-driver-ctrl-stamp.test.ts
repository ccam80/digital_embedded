/**
 * Ctrl-stamp tests for driver leaves:
 *   - BehavioralButtonLEDDriverElement (single ctrl_out, no enable)
 *   - BehavioralDriverDriverElement    (ctrl_out + ctrl_en, active-HIGH enable)
 *   - BehavioralDriverInvDriverElement (ctrl_out + ctrl_en, active-LOW enable)
 *
 * Each test verifies that after one load() cycle the Norton stamp at the
 * appropriate ctrl node matches vOH or vOL by observing the user-visible
 * output port voltage (drv:out) through a 10kOhm load to ground.
 *
 * Tier: T1 (buildFixture, headless).
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";

const VOH = 5.0;

function buildButtonLEDFixture(inVoltage: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "btnled", type: "ButtonLED",       props: { label: "btnled", model: "behavioral" } },
        { id: "vsIn",   type: "DcVoltageSource", props: { voltage: inVoltage } },
        { id: "rLoad",  type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",    type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",   "btnled:in"],
        ["btnled:out", "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
        ["vsIn:neg",   "gnd:out"],
      ],
    }),
  });
}

function buildDriverFixture(inVoltage: number, selVoltage: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "drv",   type: "Driver",          props: { label: "drv", model: "behavioral" } },
        { id: "vsIn",  type: "DcVoltageSource", props: { voltage: inVoltage } },
        { id: "vsSel", type: "DcVoltageSource", props: { voltage: selVoltage } },
        { id: "rLoad", type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",  "drv:in"],
        ["vsSel:pos", "drv:sel"],
        ["drv:out",   "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsIn:neg",  "gnd:out"],
        ["vsSel:neg", "gnd:out"],
      ],
    }),
  });
}

function buildDriverInvFixture(inVoltage: number, selVoltage: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "drv",   type: "DriverInvSel",    props: { label: "drv", model: "behavioral" } },
        { id: "vsIn",  type: "DcVoltageSource", props: { voltage: inVoltage } },
        { id: "vsSel", type: "DcVoltageSource", props: { voltage: selVoltage } },
        { id: "rLoad", type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",  "drv:in"],
        ["vsSel:pos", "drv:sel"],
        ["drv:out",   "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsIn:neg",  "gnd:out"],
        ["vsSel:neg", "gnd:out"],
      ],
    }),
  });
}

describe("BehavioralButtonLEDDriver — ctrl_out Norton stamp (Cat 2 analytical)", () => {
  it("stamps vOH at ctrl_out when in voltage is above vIH (LED on)", () => {
    const fix = buildButtonLEDFixture(3.3);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["btnled:out"];
    expect(vOut).toBeGreaterThan(VOH * 0.9);
    expect(vOut).toBeLessThan(VOH * 1.1);
  });

  it("stamps vOL at ctrl_out when in voltage is below vIL (LED off)", () => {
    const fix = buildButtonLEDFixture(0.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["btnled:out"];
    expect(vOut).toBeLessThan(0.5);
  });
});

describe("BehavioralDriverDriver — ctrl_out + ctrl_en Norton stamps (Cat 2 analytical)", () => {
  it("stamps vOH at out when in=HIGH and sel=HIGH (enabled, data high)", () => {
    const fix = buildDriverFixture(3.3, 3.3);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeGreaterThan(3.0);
    expect(vOut).toBeLessThan(VOH * 1.1);
  });

  it("stamps vOL at out when in=LOW and sel=HIGH (enabled, data low)", () => {
    const fix = buildDriverFixture(0.0, 3.3);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeLessThan(0.5);
  });

  it("output is pulled to near-zero by load when sel=LOW (high-Z: enable inactive)", () => {
    const fix = buildDriverFixture(3.3, 0.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeLessThan(0.1);
  });
});

describe("BehavioralDriverInvDriver — ctrl_out + ctrl_en with inverted sel (Cat 2 analytical)", () => {
  it("stamps vOH at out when in=HIGH and sel=LOW (active-LOW enable asserted)", () => {
    const fix = buildDriverInvFixture(3.3, 0.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeGreaterThan(3.0);
    expect(vOut).toBeLessThan(VOH * 1.1);
  });

  it("stamps vOL at out when in=LOW and sel=LOW (active-LOW enable asserted, data low)", () => {
    const fix = buildDriverInvFixture(0.0, 0.0);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeLessThan(0.5);
  });

  it("output is pulled to near-zero by load when sel=HIGH (active-LOW enable not asserted: high-Z)", () => {
    const fix = buildDriverInvFixture(3.3, 3.3);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeLessThan(0.1);
  });
});
