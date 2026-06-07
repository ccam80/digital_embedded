import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { SCHMITT_TRIGGER_SCHEMA } from "../schmitt-trigger-driver.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Slot indices
// ---------------------------------------------------------------------------

const SLOT_OUTPUT_LATCH = SCHMITT_TRIGGER_SCHEMA.indexOf.get("OUTPUT_LATCH")!;

// ---------------------------------------------------------------------------
// Helper: locate the SchmittTriggerDriverElement in a compiled circuit by
// matching stateSchema.owner === "SchmittTriggerDriverElement".
// ---------------------------------------------------------------------------

function findSchmittDriver(
  elements: ReadonlyArray<unknown>,
): PoolBackedAnalogElement {
  const idx = elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "SchmittTriggerDriverElement",
  );
  if (idx < 0) throw new Error("SchmittTriggerDriverElement not found in compiled circuit");
  return elements[idx] as PoolBackedAnalogElement;
}

// ---------------------------------------------------------------------------
// Programmatic builders for T1 categories.
// ---------------------------------------------------------------------------

function buildNonInvFixture(opts: { vIn: number; tStop?: number; maxTimeStep?: number }) {
  const { vIn, tStop = 2e-5, maxTimeStep = 1e-6 } = opts;
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vsrc",  type: "DcVoltageSource", props: { label: "vsrc", voltage: vIn } },
        { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 10000 } },
        {
          id: "st",
          type: "SchmittNonInverting",
          props: { label: "st", vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut: 50 },
        },
        { id: "gnd", type: "Ground", props: { label: "gnd" } },
      ],
      connections: [
        ["vsrc:pos", "st:in"],
        ["vsrc:neg", "gnd:out"],
        ["st:out",   "rload:pos"],
        ["rload:neg", "gnd:out"],
      ],
    }),
    params: { tStop, maxTimeStep },
  });
}

function buildInvFixture(opts: { vIn: number; tStop?: number; maxTimeStep?: number }) {
  const { vIn, tStop = 2e-5, maxTimeStep = 1e-6 } = opts;
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vsrc",  type: "DcVoltageSource", props: { label: "vsrc", voltage: vIn } },
        { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 10000 } },
        {
          id: "st",
          type: "SchmittInverting",
          props: { label: "st", vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut: 50 },
        },
        { id: "gnd", type: "Ground", props: { label: "gnd" } },
      ],
      connections: [
        ["vsrc:pos", "st:in"],
        ["vsrc:neg", "gnd:out"],
        ["st:out",   "rload:pos"],
        ["rload:neg", "gnd:out"],
      ],
    }),
    params: { tStop, maxTimeStep },
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Post-warm-start: OUTPUT_LATCH slot holds the committed output level.
// Two topology variants (non-inverting, inverting) are covered since the
// inverting flag drives a distinct branch in load() that flips the output sense.
// ---------------------------------------------------------------------------

describe("Schmitt initialization — non-inverting (T1)", () => {
  it("init_noninv_low_input_latch_zero", () => {
    // vIn=0.5 < vTL=1.0: non-inverting latch settles LOW (0).
    const fix = buildNonInvFixture({ vIn: 0.5 });
    const drv = findSchmittDriver(fix.circuit.elements);
    const latch = fix.pool.state0[drv._stateBase + SLOT_OUTPUT_LATCH];
    expect(latch).toBe(0);
    // Output node settles toward vOL = 0V.
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(0.0, 3);
  });

  it("init_noninv_high_input_latch_one", () => {
    // vIn=2.5 > vTH=2.0: non-inverting latch settles HIGH (1).
    const fix = buildNonInvFixture({ vIn: 2.5 });
    const drv = findSchmittDriver(fix.circuit.elements);
    const latch = fix.pool.state0[drv._stateBase + SLOT_OUTPUT_LATCH];
    expect(latch).toBe(1);
    // Output node settles toward vOH * rload/(rOut+rload) = 3.3*10000/10050 ≈ 3.284V.
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeGreaterThan(3.0);
  });
});

describe("Schmitt initialization — inverting (T1)", () => {
  it("init_inv_low_input_output_high", () => {
    // vIn=0.5 < vTL=1.0: inverting drives output toward vOH (inverted sense).
    // OUTPUT_LATCH stores pre-invert level: latch=0, but output sense is flipped.
    const fix = buildInvFixture({ vIn: 0.5 });
    const drv = findSchmittDriver(fix.circuit.elements);
    const latch = fix.pool.state0[drv._stateBase + SLOT_OUTPUT_LATCH];
    expect(latch).toBe(0);
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeGreaterThan(3.0);
  });

  it("init_inv_high_input_output_low", () => {
    // vIn=2.5 > vTH=2.0: inverting drives output toward vOL.
    const fix = buildInvFixture({ vIn: 2.5 });
    const drv = findSchmittDriver(fix.circuit.elements);
    const latch = fix.pool.state0[drv._stateBase + SLOT_OUTPUT_LATCH];
    expect(latch).toBe(1);
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(0.0, 3);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point analytical (T1)
// Closed-form: vOut = vTarget * rload / (rOut + rload).
// rOut=50, rload=10000:
//   active HIGH: vOut = 3.3 * 10000/10050 = 3.28358...V
//   active LOW:  vOut = 0.0V
// ---------------------------------------------------------------------------

describe("Schmitt DCOP analytical (T1)", () => {
  it("dcop_noninv_low_output_zero", () => {
    const fix = buildNonInvFixture({ vIn: 0.5 });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(0.0, 3);
  });

  it("dcop_noninv_high_output_near_voh", () => {
    const fix = buildNonInvFixture({ vIn: 2.5 });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    // 3.3 * 10000 / 10050 = 3.28358208955...
    expect(outV).toBeCloseTo(3.3 * 10000 / 10050, 4);
  });

  it("dcop_inv_low_output_near_voh", () => {
    const fix = buildInvFixture({ vIn: 0.5 });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(3.3 * 10000 / 10050, 4);
  });

  it("dcop_inv_high_output_zero", () => {
    const fix = buildInvFixture({ vIn: 2.5 });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(0.0, 3);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// One it() per settable parameter: vTH, vTL, vOH, vOL, rOut.
// ---------------------------------------------------------------------------

describe("Schmitt parameter hot-load (T1)", () => {
  it("hotload_vTH_shifts_rising_threshold", () => {
    // Non-inverting; vIn=1.5 is between vTL=1.0 and vTH=2.0.
    // After warm-start the latch is LOW. Lower vTH to 1.0: input 1.5 now
    // exceeds vTH, latch flips HIGH, output rises toward vOH*rload/(rOut+rload).
    const fix = buildNonInvFixture({ vIn: 1.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(0.0, 3);

    fix.coordinator.setComponentProperty(fix.element("st"), "vTH", 1.0);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(3.3 * 10000 / 10050, 3);
  });

  it("hotload_vTL_shifts_falling_threshold", () => {
    // Non-inverting; start with vIn=2.5 => latch HIGH. Raise vTL to 2.6:
    // input 2.5 < vTL, latch falls to LOW, output drops to vOL = 0V.
    const fix = buildNonInvFixture({ vIn: 2.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeGreaterThan(3.0);

    fix.coordinator.setComponentProperty(fix.element("st"), "vTL", 2.6);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(0.0, 3);
  });

  it("hotload_vOH_changes_output_high_level", () => {
    // Non-inverting active HIGH; raising vOH from 3.3 to 5.0 increases output.
    // after = 5.0 * 10000/10050 ≈ 4.975V
    const fix = buildNonInvFixture({ vIn: 2.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    const before = fix.engine.getNodeVoltage(outNode);

    fix.coordinator.setComponentProperty(fix.element("st"), "vOH", 5.0);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(5.0 * 10000 / 10050, 3);
  });

  it("hotload_vOL_changes_output_low_level", () => {
    // Non-inverting active LOW; raise vOL from 0 to 0.4.
    // after = 0.4 * 10000/10050 ≈ 0.3980V
    const fix = buildNonInvFixture({ vIn: 0.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeCloseTo(0.0, 3);

    fix.coordinator.setComponentProperty(fix.element("st"), "vOL", 0.4);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(0.4 * 10000 / 10050, 3);
  });

  it("hotload_rOut_changes_output_divider", () => {
    // Non-inverting active HIGH at vIn=2.5.
    // Raise rOut from 50 to 5000: output drops from 3.3*10000/10050 to 3.3*10000/15000.
    //   before ≈ 3.284V, after ≈ 2.200V
    const fix = buildNonInvFixture({ vIn: 2.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    const before = fix.engine.getNodeVoltage(outNode);

    fix.coordinator.setComponentProperty(fix.element("st"), "rOut", 5000);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(3.3 * 10000 / 15000, 2);
  });
});
