/**
 * Ctrl-stamp tests for Wave 4.7 switching driver leaves:
 *   - BehavioralFETDriver (ctrl_out Norton stamp)
 *   - NFET composite (G above Vth -> D-S conducting)
 *   - PFET composite (G below -Vth -> D-S conducting, inverted polarity)
 *
 * Tier: T1 (buildFixture, headless).
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

const VOH = 5.0;
const VOL = 0.0;
const VTH = 2.5;

// NFET canonical topology: S=GND, rLoad between VDD and D, G driven by vsG.
// When on (vGS = vG - 0 = vG > Vth): D pulled low through Ron toward GND.
// When off: D pulled high through rLoad from VDD.
function buildNfetFixture(vGate: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "nfet",  type: "NFET",            props: { label: "nfet", model: "behavioral", Vth: VTH } },
        { id: "vsG",   type: "DcVoltageSource",  props: { voltage: vGate } },
        { id: "vsVdd", type: "DcVoltageSource",  props: { voltage: VOH } },
        { id: "rLoad", type: "Resistor",         props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsG:pos",   "nfet:G"],
        ["vsVdd:pos", "rLoad:pos"],
        ["rLoad:neg", "nfet:D"],
        ["nfet:S",    "gnd:out"],
        ["vsG:neg",   "gnd:out"],
        ["vsVdd:neg", "gnd:out"],
      ],
    }),
  });
}

// PFET canonical topology: S=VDD, rLoad between D and GND, G driven by vsG.
// When on (vGS = vG - VOH < -Vth): D pulled high through Ron from VDD.
// When off: D pulled low through rLoad to GND.
function buildPfetFixture(vGate: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "pfet",  type: "PFET",            props: { label: "pfet", model: "behavioral", Vth: VTH } },
        { id: "vsG",   type: "DcVoltageSource",  props: { voltage: vGate } },
        { id: "vsVdd", type: "DcVoltageSource",  props: { voltage: VOH } },
        { id: "rLoad", type: "Resistor",         props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsG:pos",   "pfet:G"],
        ["vsVdd:pos", "pfet:S"],
        ["pfet:D",    "rLoad:pos"],
        ["rLoad:neg", "gnd:out"],
        ["vsG:neg",   "gnd:out"],
        ["vsVdd:neg", "gnd:out"],
      ],
    }),
  });
}

describe("NFET behavioral — ctrl_out Norton stamp via BehavioralFETDriver (Cat 2 analytical)", () => {
  it("D pulled LOW when gate is above Vth (vG=5V > Vth=2.5V, S=GND)", () => {
    const fix = buildNfetFixture(VOH);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    // D pulled low through Ron=1 Ohm to GND. V(D) ~ 0 + Ron/(Ron+rLoad)*VOH ~ 0.0005V.
    expect(signals["nfet:D"]).toBeLessThan(VOH * 0.1);
  });

  it("D stays HIGH when gate is below Vth (vG=0V < Vth=2.5V, S=GND)", () => {
    const fix = buildNfetFixture(VOL);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    // D pulled high through rLoad from VDD. With Roff=1e9, V(D) ~ VOH.
    expect(signals["nfet:D"]).toBeGreaterThan(VOH * 0.8);
  });
});

describe("PFET behavioral — ctrl_out Norton stamp via BehavioralFETDriver (Cat 2 analytical)", () => {
  it("D pulled HIGH when gate is at 0V (vGS = 0 - VOH = -VOH < -Vth, S=VDD)", () => {
    const fix = buildPfetFixture(VOL);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    // D follows S through Ron=1 Ohm. V(D) ~ VOH * rLoad/(Ron+rLoad) ~ 4.9995V.
    expect(signals["pfet:D"]).toBeGreaterThan(VOH * 0.8);
  });

  it("D stays LOW when gate is at VOH (vGS = VOH - VOH = 0, not below -Vth, S=VDD)", () => {
    const fix = buildPfetFixture(VOH);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    fix.coordinator.step();
    const signals = fix.facade.readAllSignals(fix.coordinator);
    // D pulled to 0 through rLoad with Roff=1e9.
    expect(signals["pfet:D"]).toBeLessThan(VOH * 0.1);
  });
});
