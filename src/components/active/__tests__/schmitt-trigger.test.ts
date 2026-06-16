import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

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
  it("init_noninv_low_input_output_low", () => {
    // vIn=0.5 < vTL=1.0: non-inverting output settles toward vOL = 0V.
    const fix = buildNonInvFixture({ vIn: 0.5 });
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(0.0, 3);
  });

  it("init_noninv_high_input_output_high", () => {
    // vIn=2.5 > vTH=2.0: non-inverting output settles toward vOH*rload/(rOut+rload).
    const fix = buildNonInvFixture({ vIn: 2.5 });
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(3.3 * 10000 / 10050, 3);
  });
});

describe("Schmitt initialization — inverting (T1)", () => {
  it("init_inv_low_input_output_high", () => {
    // vIn=0.5 < vTL=1.0: inverting output settles toward vOH (inverted sense).
    const fix = buildInvFixture({ vIn: 0.5 });
    const outV = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("st:out")!);
    expect(outV).toBeCloseTo(3.3 * 10000 / 10050, 3);
  });

  it("init_inv_high_input_output_low", () => {
    // vIn=2.5 > vTH=2.0: inverting output settles toward vOL = 0V.
    const fix = buildInvFixture({ vIn: 2.5 });
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
// Category 3 — Transient input sweep (Phase-1 proof: ring-free crossing)
// A slow sine sweeps the input through vTL and vTH and back. The Hyst transfer
// is continuous and Jacobian-coupled, so the output must track the rails with
// NO overshoot- the ring the deleted stiff-Norton driver produced.
// ---------------------------------------------------------------------------

describe("Schmitt transient input sweep (T1)", () => {
  it("noninv_swept_input_no_overshoot", () => {
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsrc",  type: "AcVoltageSource", props: { label: "vsrc", waveform: "sine", amplitude: 1.5, dcOffset: 1.5, frequency: 1000 } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 10000 } },
          { id: "st",    type: "SchmittNonInverting", props: { label: "st", vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut: 50 } },
          { id: "gnd",   type: "Ground", props: { label: "gnd" } },
        ],
        connections: [
          ["vsrc:pos", "st:in"], ["vsrc:neg", "gnd:out"],
          ["st:out", "rload:pos"], ["rload:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-6 },
    });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    const vHigh = 3.3 * 10000 / 10050;
    let maxOut = -Infinity;
    let minOut = Infinity;
    for (let i = 0; i < 1000; i++) {
      fix.coordinator.step();
      const v = fix.engine.getNodeVoltage(outNode);
      if (v > maxOut) maxOut = v;
      if (v < minOut) minOut = v;
    }
    // Ring-free: never overshoots the high-rail divider, never undershoots vOL.
    expect(maxOut).toBeLessThanOrEqual(vHigh + 0.01);
    expect(minOut).toBeGreaterThanOrEqual(-0.01);
    // And the sweep actually drove both rails (crossed both thresholds).
    expect(maxOut).toBeGreaterThan(vHigh - 0.05);
    expect(minOut).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// One it() per settable parameter: vTH, vTL, vOH, vOL, rOut.
// ---------------------------------------------------------------------------

describe("Schmitt parameter hot-load (T1)", () => {
  it("hotload_vTH_shifts_rising_threshold", () => {
    // Phase 2: live param-hotload discontinuity- a setComponentProperty rail-step
    // rings into cOut at dt≫τ; the boundary forward-discontinuity fixes this, not
    // the Hyst transfer (which only makes the input crossing continuous).
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
    // Non-inverting; start with vIn=2.5 => latch HIGH. Raise the whole hysteresis
    // band above the input while keeping vTH > vTL (vTH=3.0, vTL=2.6): input 2.5
    // now sits below vTL, so the latch falls to LOW and HOLDS (2.5 < vTH=3.0, no
    // re-trigger), output drops to vOL = 0V. Raising vTL alone above vTH would
    // invert the band and oscillate the latch.
    const fix = buildNonInvFixture({ vIn: 2.5, tStop: 1e-3, maxTimeStep: 1e-6 });
    const outNode = fix.circuit.labelToNodeId.get("st:out")!;
    const before = fix.engine.getNodeVoltage(outNode);
    expect(before).toBeGreaterThan(3.0);

    fix.coordinator.setComponentProperty(fix.element("st"), "vTH", 3.0);
    fix.coordinator.setComponentProperty(fix.element("st"), "vTL", 2.6);
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode);
    expect(after).toBeCloseTo(0.0, 3);
  });

  it("hotload_vOH_changes_output_high_level", () => {
    // Phase 2: live param-hotload discontinuity (rail-step rings into cOut at dt≫τ).
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
    // Phase 2: live param-hotload discontinuity (rail-step rings into cOut at dt≫τ).
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
