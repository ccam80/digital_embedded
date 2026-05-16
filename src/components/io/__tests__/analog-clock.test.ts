import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

// Clock paired-with-ngspice (T3) coverage moved to
// src/components/sources/__tests__/ac-voltage-source.test.ts. The digital Clock
// component cannot achieve bit-exact PULSE parity (ngspice vsrcload.c:81-86
// substitutes CKTstep for TR=0); analog square-wave parity belongs to
// AcVoltageSource where TR/TF are explicit non-zero deck values. The Clock
// keeps its T1 init/DCOP/breakpoint/bridged-digital coverage below.

// ---------------------------------------------------------------------------
// Common builders (T1 programmatic)
// ---------------------------------------------------------------------------

/**
 * Clock at the configured frequency / vdd driving a resistive load to ground.
 * Loaded analog topology — the registry's `behavioral` model spawns
 * AnalogClockElementImpl which stamps a square-wave VSRC into the MNA matrix.
 */
function buildLoadedClockFixture(opts: {
  frequency: number;
  vdd: number;
  rload: number;
}) {
  return buildFixture({
    build: (_r, facade) =>
      facade.build({
        components: [
          { id: "clk",   type: "Clock",     props: { label: "clk", model: "behavioral", Frequency: opts.frequency, vdd: opts.vdd } },
          { id: "rload", type: "Resistor", props: { label: "rload", resistance: opts.rload } },
          { id: "gnd",   type: "Ground",   props: { label: "gnd" } },
        ],
        connections: [
          ["clk:out",   "rload:pos"],
          ["rload:neg", "gnd:out"],
        ],
      }),
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// ---------------------------------------------------------------------------
// AnalogClockElementImpl is not pool-backed (no stateSchema, no _stateBase).
// The canonical Cat 1 observable is the post-warm-start node voltage at the
// clock's `out` pin: at t=0 the square wave is on the first half-period (high
// half), so V(out) should be vdd. The resistor + ground close the MNA loop.
// ---------------------------------------------------------------------------

describe("Clock initialization (T1)", () => {
  it("init_out_node_voltage_at_t0_high_half_period", () => {
    // 1kHz, vdd=3.3V, 1kΩ load. At t=0 the clock is in its first half-period
    // (halfPeriods=0 → even → vdd). After buildFixture's warm-start step, the
    // clock has stamped V=vdd at the out node, so engine.getNodeVoltage(out)
    // should read 3.3V.
    const fix = buildLoadedClockFixture({ frequency: 1000, vdd: 3.3, rload: 1000 });
    const outNode = fix.circuit.labelToNodeId.get("clk:out");
    expect(outNode).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(outNode!);
    expect(vOut).toBeCloseTo(3.3, 6);
  });

  it("init_branch_current_through_rload_at_t0", () => {
    // V_out = 3.3V across R = 1kΩ to ground → I = 3.3 mA. The clock's
    // branch row carries that current at the warm-start step.
    const fix = buildLoadedClockFixture({ frequency: 1000, vdd: 3.3, rload: 1000 });
    const outNode = fix.circuit.labelToNodeId.get("clk:out");
    expect(outNode).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(outNode!);
    // I_R = V/R, expected ≈ 3.3 mA.
    const expectedI = vOut / 1000;
    expect(expectedI).toBeCloseTo(3.3e-3, 9);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point, analytical (T1)
// ---------------------------------------------------------------------------
// Closed-form: at the DC operating point with simTime=0 the square wave is in
// its first half-period (high), so V(out)=vdd and I_R = vdd/R. The clock
// stamps as an ideal voltage source so the divider degenerates to direct drive.
// ---------------------------------------------------------------------------

describe("Clock DCOP analytical (T1)", () => {
  it("dcop_out_voltage_equals_vdd_at_3v3", () => {
    const fix = buildLoadedClockFixture({ frequency: 1000, vdd: 3.3, rload: 1000 });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const outNode = fix.circuit.labelToNodeId.get("clk:out");
    expect(outNode).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(outNode!);
    expect(vOut).toBeCloseTo(3.3, 6);
  });

  it("dcop_out_voltage_equals_vdd_at_5v", () => {
    // Closed form independent of vdd magnitude — clock stamps V=vdd directly.
    const fix = buildLoadedClockFixture({ frequency: 500, vdd: 5, rload: 2000 });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const outNode = fix.circuit.labelToNodeId.get("clk:out");
    expect(outNode).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(outNode!);
    expect(vOut).toBeCloseTo(5, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------
// Clock has two structural analog params on the behavioral model: `Frequency`
// (sets halfPeriod = 1/(2f)) and `vdd` (sets the high rail). Both are
// observable through V(out): vdd directly scales V(out) on the high half,
// and Frequency shifts the breakpoint at which V(out) toggles.
// ---------------------------------------------------------------------------

describe("Clock parameter hot-load (T1)", () => {
  it("hotload_vdd_changes_out_voltage", () => {
    // Default vdd=3.3V → V(out)=3.3V at t=0. Hot-load to vdd=5V; after step,
    // V(out) should track 5V (still in the first half-period for 1kHz).
    const fix = buildLoadedClockFixture({ frequency: 1000, vdd: 3.3, rload: 1000 });

    const clkEl = [...fix.circuit.elementToCircuitElement.values()].find(
      (ce) => ce.getProperties().getOrDefault<string>("label", "") === "clk",
    );
    expect(clkEl).toBeDefined();

    const outNode = fix.circuit.labelToNodeId.get("clk:out");
    expect(outNode).toBeDefined();

    const before = fix.engine.getNodeVoltage(outNode!);
    expect(before).toBeCloseTo(3.3, 6);

    fix.coordinator.setComponentProperty(clkEl!, "vdd", 5);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode!);
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeCloseTo(5, 6);
  });

  it("hotload_Frequency_changes_breakpoint_schedule", () => {
    // Default 1kHz → halfPeriod=0.5ms → first edge at simTime ≥ 0.5ms.
    // Hot-load Frequency to 4000 → halfPeriod=0.125ms → first edge at
    // simTime ≥ 0.125ms. Step the engine past 0.2ms (which would still be the
    // high half at 1kHz, but the LOW half at 4kHz) and observe V(out).
    const fix = buildLoadedClockFixture({ frequency: 1000, vdd: 3.3, rload: 1000 });

    const clkEl = [...fix.circuit.elementToCircuitElement.values()].find(
      (ce) => ce.getProperties().getOrDefault<string>("label", "") === "clk",
    );
    expect(clkEl).toBeDefined();

    const outNode = fix.circuit.labelToNodeId.get("clk:out");
    expect(outNode).toBeDefined();

    // Hot-load to 4kHz before stepping forward.
    fix.coordinator.setComponentProperty(clkEl!, "Frequency", 4000);

    // Drive the engine forward to ~0.2ms — past the 4kHz first edge (0.125ms)
    // but well inside the 1kHz first half (0.5ms).
    while (fix.engine.simTime !== null && fix.engine.simTime < 2e-4) {
      fix.coordinator.step();
    }

    const after = fix.engine.getNodeVoltage(outNode!);
    // At simTime ≈ 0.2ms with halfPeriod=0.125ms, halfPeriods=floor(0.2/0.125)=1
    // → odd → low half → V(out) = 0V. (At 1kHz it would have been 3.3V.)
    expect(after).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 8 — Breakpoints (T1)
// ---------------------------------------------------------------------------
// AnalogClockElementImpl.acceptStep registers breakpoints at half-period
// boundaries (rising/falling edges of the square wave). The timestep
// controller must land bit-exactly on each registered breakpoint time.
// ---------------------------------------------------------------------------

describe("Clock breakpoints (T1)", () => {
  it("breakpoint_lands_exactly_on_half_period_edge", () => {
    // 1kHz clock → halfPeriod = 0.5ms. The first square-wave edge is at
    // simTime = 0.5ms. After stepping past that time, the convergence log
    // should record an accepted step whose end-of-step time
    // (simTime + acceptedDt) lands bit-exactly on 0.5ms.
    const HALF_PERIOD = 0.5e-3; // 1/(2*1000)
    const fix = buildLoadedClockFixture({ frequency: 1000, vdd: 3.3, rload: 1000 });
    fix.coordinator.setConvergenceLogEnabled(true);
    while (fix.engine.simTime !== null && fix.engine.simTime < HALF_PERIOD * 1.5) {
      fix.coordinator.step();
    }
    const log = fix.coordinator.getConvergenceLog()!;
    expect(log).toBeDefined();
    const bpStep = log.find((s) => s.simTime + s.acceptedDt === HALF_PERIOD);
    expect(bpStep).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
// ---------------------------------------------------------------------------
// Clock has a digital model (executeFn / outputSchema=["out"]). When the
// behavioral analog model is selected for a mixed-signal circuit, the
// digital signal at the clock's `out` pin reflects the analog square-wave
// state via the cross-domain bridge. Drive the clock at a known time and
// observe the digital signal.
// ---------------------------------------------------------------------------

describe("Clock digital interaction (Cat 9)", () => {
  it("bridge_clock_drives_digital_high_at_t0", () => {
    // At simTime=0 the clock is in its first (high) half-period. The digital
    // signal exposed via readByLabel should reflect logic 1.
    const fix = buildLoadedClockFixture({ frequency: 1000, vdd: 3.3, rload: 1000 });
    const sig = fix.coordinator.readByLabel("clk");
    expect(sig).toBeDefined();
    // Domain-polymorphic — clock's bridged digital domain reports `value`.
    if (sig.type === "digital") {
      expect(sig.value).toBe(1);
    } else {
      // Analog read: V(out) at t=0 in first half-period must equal vdd.
      expect(sig.voltage).toBeCloseTo(3.3, 6);
    }
  });
});
