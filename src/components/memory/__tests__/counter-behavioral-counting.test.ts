import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import { BehavioralCounterDriverElement } from "../../../solver/analog/behavioral-drivers/counter-driver.js";
import { BehavioralCounterPresetDriverElement } from "../../../solver/analog/behavioral-drivers/counter-preset-driver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Behavioral Counter / CounterPreset — multi-bit counting — Surface 1 (T1)
//
// Canon category: 9 (Bridge / digital interaction). Analog DC voltage sources
// drive the composite's digital input pins (en, C, clr, dir, ld, in); the
// behavioral counter is the cross-domain consumer whose internal latch state
// is observed through the driver leaf's per-bit ctrl output nodes.
//
// Tier: T1 buildFixture. The behavioral counter is an analog netlist
// composite; buildFixture is the sanctioned analog construction surface
// (test-tools.md §1, §3). No ngspice pairing is needed — the asserted
// quantities are the leaf's own integer bit-pattern outputs, not numerical
// parity values.
//
// Why the driver-leaf ctrl_bit_i nodes are the observation surface:
//   The behavioral Counter / CounterPreset composites pack all N output bits
//   onto one shared "out" bus node — every outBit{i} DigitalOutputPin stamps
//   the same node, so the composite "out" pin voltage is a contended sum and
//   cannot reveal a per-bit pattern. The driver leaf
//   (BehavioralCounterDriver / BehavioralCounterPresetDriver) exposes one
//   ctrl_bit_i output pin per bit plus ctrl_ovf, each driven by exactly one
//   Norton stamp — so reading each ctrl_bit_i node directly yields that bit's
//   {0,1}-normalized value. This is the precedent surface established by
//   memory-driver-ctrl-stamp.test.ts; that file only exercises bitWidth=1, so
//   no test drives a multi-bit ripple sequence through the leaf — this file
//   closes that gap.
//
// Internal ctrl_* nodes carry NORMALIZED {0,1} V; input DC sources drive at
// rail voltages (VOH/VOL) and the driver threshold-snaps at 0.5 V.
// ---------------------------------------------------------------------------

const VOH = 5.0;
const VOL = 0.0;

// A bit on the ctrl_bit_i / ctrl_ovf nodes reads 1.0 V (set) or 0.0 V (clear).
const HI = 1.0;
const LO = 0.0;

type CounterDriverClass =
  | typeof BehavioralCounterDriverElement
  | typeof BehavioralCounterPresetDriverElement;

function findDriverElement(
  fix: ReturnType<typeof buildFixture>,
  DriverCls: CounterDriverClass,
): AnalogElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof DriverCls) return el;
  }
  throw new Error("No " + DriverCls.name + " found in compiled circuit");
}

/** Voltage on one named output pin of the driver leaf, referenced to its gnd pin. */
function ctrlV(
  fix: ReturnType<typeof buildFixture>,
  el: AnalogElement,
  pin: string,
): number {
  const node = el.pinNodes.get(pin);
  const gnd  = el.pinNodes.get("gnd");
  if (node === undefined) throw new Error(pin + " pin not found on driver");
  if (gnd  === undefined) throw new Error("gnd pin not found on driver");
  return fix.engine.getNodeVoltage(node) - fix.engine.getNodeVoltage(gnd);
}

/**
 * Read the driver leaf's count as an integer, LSB = ctrl_bit_0. Each bit node
 * settles at ~1.0 V (set) or ~0.0 V (clear); >0.5 V is treated as set.
 */
function readCount(
  fix: ReturnType<typeof buildFixture>,
  el: AnalogElement,
  bitWidth: number,
): number {
  let value = 0;
  for (let i = 0; i < bitWidth; i++) {
    const v = ctrlV(fix, el, `ctrl_bit_${i}`);
    expect(v).toBeGreaterThan(-0.01);
    expect(v).toBeLessThan(1.01);
    if (v > 0.5) value |= (1 << i);
  }
  return value >>> 0;
}

/**
 * Drive one full rising-edge clock cycle on the named clock source:
 * low → high → low, stepping the transient engine at each level so the
 * driver leaf samples the 0→1 transition exactly once.
 */
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
// Counter (up-counter) — 4-bit behavioral model
// ===========================================================================

function buildCounterFixture(bitWidth: number) {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsEN",  type: "DcVoltageSource", props: { label: "vsEN",  voltage: VOL } },
          { id: "vsC",   type: "DcVoltageSource", props: { label: "vsC",   voltage: VOL } },
          { id: "vsCLR", type: "DcVoltageSource", props: { label: "vsCLR", voltage: VOL } },
          { id: "ctr",   type: "Counter",         props: { label: "ctr",   bitWidth, model: "behavioral" } },
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

describe("Counter (behavioral) — multi-bit up-counting (T1, Cat 9)", () => {
  it("4-bit counter ripples 0→1→…→15 then wraps 15→0, one edge per count", () => {
    // Each rising edge with en=1, clr=0 increments by exactly 1. This sequence
    // is what the carry-from-state_i fix protects: a carry computed from the
    // post-toggle bit would jump 0→1111 in one edge instead of 0→0001, and
    // 0011→0100 would not ripple correctly.
    const fix = buildCounterFixture(4);
    const el = findDriverElement(fix, BehavioralCounterDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    expect(readCount(fix, el, 4)).toBe(0);
    for (let expected = 1; expected <= 15; expected++) {
      pulseClock(fix, "vsC");
      expect(readCount(fix, el, 4)).toBe(expected);
    }
    // 15 → 0 wrap.
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(0);
  });

  it("en low holds the count across rising edges", () => {
    const fix = buildCounterFixture(4);
    const el = findDriverElement(fix, BehavioralCounterDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    // Count up to 5.
    for (let i = 0; i < 5; i++) pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(5);

    // Disable: rising edges must not advance the count.
    fix.facade.setSignal(fix.coordinator, "vsEN", VOL);
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(5);
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(5);
  });

  it("clr clears the count to 0 on a rising edge", () => {
    const fix = buildCounterFixture(4);
    const el = findDriverElement(fix, BehavioralCounterDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    // Count up to 7 — a non-trivial multi-bit pattern (0111).
    for (let i = 0; i < 7; i++) pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(7);

    // Assert clr: the next rising edge forces every bit to 0.
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOH);
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(0);
  });

  it("ovf is a level signal: high while at all-ones with en high, not a one-edge pulse", () => {
    const fix = buildCounterFixture(4);
    const el = findDriverElement(fix, BehavioralCounterDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    // Below terminal count — ovf low.
    for (let i = 0; i < 14; i++) pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(14);
    expect(ctrlV(fix, el, "ctrl_ovf")).toBeCloseTo(LO, 4);

    // Reach all-ones (15): ovf goes high.
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(15);
    expect(ctrlV(fix, el, "ctrl_ovf")).toBeCloseTo(HI, 4);

    // ovf is a terminal-count level, not an edge pulse: it stays high while
    // the counter sits at all-ones with en still high. The driver re-evaluates
    // ovf every load(), so a non-clocking step keeps it asserted.
    fix.coordinator.step();
    expect(readCount(fix, el, 4)).toBe(15);
    expect(ctrlV(fix, el, "ctrl_ovf")).toBeCloseTo(HI, 4);

    // Dropping en clears ovf (the terminal-count gate requires en high).
    fix.facade.setSignal(fix.coordinator, "vsEN", VOL);
    fix.coordinator.step();
    expect(readCount(fix, el, 4)).toBe(15);
    expect(ctrlV(fix, el, "ctrl_ovf")).toBeCloseTo(LO, 4);
  });
});

// ===========================================================================
// CounterPreset (up/down + parallel load) — 4-bit behavioral model
// ===========================================================================

function buildCounterPresetFixture(bitWidth: number) {
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
          { id: "ctp",   type: "CounterPreset",   props: { label: "ctp",   bitWidth, model: "behavioral" } },
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

describe("CounterPreset (behavioral) — multi-bit up/down counting + load (T1, Cat 9)", () => {
  it("dir=0 up-counts 0→1→…→7, one edge per count", () => {
    const fix = buildCounterPresetFixture(4);
    const el = findDriverElement(fix, BehavioralCounterPresetDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOL);   // up
    fix.facade.setSignal(fix.coordinator, "vsLD", VOL);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    expect(readCount(fix, el, 4)).toBe(0);
    for (let expected = 1; expected <= 7; expected++) {
      pulseClock(fix, "vsC");
      expect(readCount(fix, el, 4)).toBe(expected);
    }
  });

  it("dir=1 down-counts 5→4→…→0 then wraps 0→15, one edge per count", () => {
    const fix = buildCounterPresetFixture(4);
    const el = findDriverElement(fix, BehavioralCounterPresetDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    // Parallel-load 5 (0101) so the down-sequence starts from a known value.
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsLD", VOH);
    fix.facade.setSignal(fix.coordinator, "vsIN", 5);
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(5);

    // Switch to down-count.
    fix.facade.setSignal(fix.coordinator, "vsLD", VOL);
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOH);
    for (let expected = 4; expected >= 0; expected--) {
      pulseClock(fix, "vsC");
      expect(readCount(fix, el, 4)).toBe(expected);
    }
    // 0 → 15 underflow wrap.
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(15);
  });

  it("ld loads the in-bus value, then counting continues from the loaded value", () => {
    const fix = buildCounterPresetFixture(4);
    const el = findDriverElement(fix, BehavioralCounterPresetDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOL);   // up
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    // Load 10 (1010) — exercises a non-contiguous bit pattern.
    fix.facade.setSignal(fix.coordinator, "vsLD", VOH);
    fix.facade.setSignal(fix.coordinator, "vsIN", 10);
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(10);

    // Continue up-counting from 10: 11, 12, 13 — each edge ripples by 1.
    fix.facade.setSignal(fix.coordinator, "vsLD", VOL);
    for (const expected of [11, 12, 13]) {
      pulseClock(fix, "vsC");
      expect(readCount(fix, el, 4)).toBe(expected);
    }
  });

  it("load then down-count: load 12, then dir=1 decrements 12→11→10", () => {
    const fix = buildCounterPresetFixture(4);
    const el = findDriverElement(fix, BehavioralCounterPresetDriverElement);
    fix.facade.setSignal(fix.coordinator, "vsEN", VOH);
    fix.facade.setSignal(fix.coordinator, "vsCLR", VOL);

    // Load 12 (1100).
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOL);
    fix.facade.setSignal(fix.coordinator, "vsLD", VOH);
    fix.facade.setSignal(fix.coordinator, "vsIN", 12);
    pulseClock(fix, "vsC");
    expect(readCount(fix, el, 4)).toBe(12);

    // Down-count from 12: 1100 → 1011 → 1010 ripples the borrow correctly.
    fix.facade.setSignal(fix.coordinator, "vsLD", VOL);
    fix.facade.setSignal(fix.coordinator, "vsDIR", VOH);
    for (const expected of [11, 10]) {
      pulseClock(fix, "vsC");
      expect(readCount(fix, el, 4)).toBe(expected);
    }
  });
});
