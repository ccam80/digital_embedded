/**
 * AcVoltageSource — canonical analog component tests.
 * Canon set: 1, 2, 3, 4, 5, 8. File tier: harness (T3 + T1).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DLL_PATH, describeIfDll } from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// .dts fixtures used by the T3 harness sessions. Per-waveform-mode coverage
// (square / sine / triangle / sawtooth) is treated as additional Cat 2-num /
// Cat 3 / Cat 5 configurations under the existing canonical categories.
//   DTS_SQUARE_RC   — reused parity fixture: square AcVoltageSource → R → C
//                     → ground (500Hz, dcOffset=0.5, amplitude=0.5,
//                     riseTime/fallTime=1ns). Operating regime: pulsed-drive
//                     RC charging.
//   DTS_SINE_RC     — authored via MCP: 1kHz sine AcVoltageSource (5V) →
//                     1kΩ → 1µF → ground. Operating regime: continuous
//                     sinusoidal drive.
//   DTS_TRIANGLE_RC — authored via MCP: 1kHz triangle AcVoltageSource (5V) →
//                     1kΩ → 1µF → ground. Operating regime: piecewise-linear
//                     rise/fall (PULSE-aligned).
//   DTS_SAWTOOTH_RC — authored via MCP: 1kHz sawtooth AcVoltageSource (5V,
//                     default fallTime=1e-12) → 1kΩ → 1µF → ground.
//                     Operating regime: long-rise / fast-fall PULSE.
// ---------------------------------------------------------------------------

const DTS_SQUARE_RC = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts",
);
const DTS_SINE_RC = path.resolve(
  "src/components/sources/__tests__/fixtures/acvsource-canon-sine-rc.dts",
);
const DTS_TRIANGLE_RC = path.resolve(
  "src/components/sources/__tests__/fixtures/acvsource-canon-triangle-rc.dts",
);
const DTS_SAWTOOTH_RC = path.resolve(
  "src/components/sources/__tests__/fixtures/acvsource-canon-sawtooth-rc.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factory shared by Cat 1, Cat 2 (analytical), Cat 4,
// and Cat 8 — AcVoltageSource → 1kΩ → ground (no capacitor for the trivial
// resistive-load DCOP path; the source's `pos` net carries the instantaneous
// waveform value at the engine's internal simTime).
// ---------------------------------------------------------------------------

interface AcSourceProps {
  amplitude?: number;
  frequency?: number;
  phase?: number;
  dcOffset?: number;
  waveform?: string;
  riseTime?: number;
  fallTime?: number;
}

function buildAcSourceCircuit(facade: DefaultSimulatorFacade, props: AcSourceProps): Circuit {
  return facade.build({
    components: [
      {
        id: "acsrc",
        type: "AcVoltageSource",
        props: { label: "acsrc", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0, waveform: "sine", ...props },
      },
      { id: "r1", type: "Resistor", props: { label: "r1", resistance: 1000 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["acsrc:pos", "r1:pos"],
      ["r1:neg", "gnd:out"],
      ["acsrc:neg", "gnd:out"],
    ],
  });
}

function getAcsrcPosNode(fix: ReturnType<typeof buildFixture>): number {
  const node =
    fix.circuit.labelToNodeId.get("acsrc:pos") ??
    fix.circuit.labelToNodeId.get("r1:pos");
  if (node === undefined) {
    throw new Error("acsrc:pos / r1:pos node not found in labelToNodeId");
  }
  return node;
}

function getAcsrcCircuitElement(fix: ReturnType<typeof buildFixture>) {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const ce = fix.circuit.elementToCircuitElement.get(i);
    if (ce === undefined) continue;
    const label = ce.getProperties().getOrDefault<string>("label", "");
    if (label === "acsrc") return ce;
  }
  throw new Error("AcVoltageSource circuit element 'acsrc' not found");
}

// ===========================================================================
// Category 1 — Initialization (T1)
//
// Closed-form expected value. AcVoltageSource: V(t) = dcOffset + amplitude *
// sin(2π*f*t + phase). After the warm-start step the engine has advanced to
// a known simTime read off `engine.simTime`; the source value at that exact
// simTime is the bit-exact analytical sin sample. Resistive load to ground
// means the pos node tracks the source value to engine precision, so the
// post-warm-start node voltage is asserted against the closed-form to 9
// decimals via `toBeCloseTo(expectedV, 9)`. NOT a B-8 rail check.
// ===========================================================================

describe("AcVoltageSource initialization (T1)", () => {
  it("init_pos_node_solved_after_warmstart", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sine", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
      }),
    });
    // Closed-form: V(t) = dcOffset + amplitude * sin(2π*f*t + phase).
    // After warm-start the engine has advanced to a known simTime; the source
    // value at that simTime is the exact analytical sin sample. Resistive
    // load to ground means the pos node tracks the source value bit-exactly.
    const t = fix.engine.simTime;
    const expectedV = 0 + 5 * Math.sin(2 * Math.PI * 1000 * t + 0);
    const v = fix.engine.getNodeVoltage(getAcsrcPosNode(fix));
    expect(v).toBeCloseTo(expectedV, 9);
  });
});

// ===========================================================================
// Category 2 — DC operating point (T1, analytical)
//
// At DCOP, the AcVoltageSource evaluates its waveform at simTime = 0 with
// MODEDCOP gating. For phase=0, dcOffset=0, sine: V(0) = 0 → resistor sees
// 0V across it → pos node sits at exactly 0V (analytical).
// ===========================================================================

describe("AcVoltageSource DCOP analytical (T1)", () => {
  it("dcop_sine_phase_zero_dc_offset_zero_yields_zero_pos", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sine", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const v = fix.engine.getNodeVoltage(getAcsrcPosNode(fix));
    // Closed-form: V(0) = dcOffset + amplitude * sin(0) = 0V (independent of
    // amplitude/frequency at phase=0). The resistive load to ground means
    // the pos node tracks the source value exactly.
    expect(v).toBeCloseTo(0, 9);
  });

  it("dcop_sine_dc_offset_drives_pos_to_offset", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sine", amplitude: 3, frequency: 1000, phase: 0, dcOffset: 1.5,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const v = fix.engine.getNodeVoltage(getAcsrcPosNode(fix));
    // V(0) = dcOffset + amplitude * sin(0) = 1.5V.
    expect(v).toBeCloseTo(1.5, 9);
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
//
// AcVoltageSource analog leaf hot-loadable params (per setParam):
//   amplitude, frequency, phase, dcOffset, riseTime, fallTime, noiseSampleTime.
// Coverage requirement: one it() per param (or per representative within a
// scaling group). Structural: amplitude, frequency, phase, dcOffset shift the
// instantaneous output. riseTime/fallTime shape the square-wave edges (only
// observable for square mode). noiseSampleTime gates noise breakpoints (no
// effect on the per-step voltage at sine mode — covered by extended-mode file).
//
// Each it() asserts the documented post-change observable on the AC source's
// pos node after setComponentProperty + step.
// ===========================================================================

describe("AcVoltageSource parameter hot-load (T1)", () => {
  it("hotload_dcOffset_shifts_pos_node_at_dcop", () => {
    // Build with phase=0, dcOffset=0 → DCOP value V(0) = 0. After hot-load
    // dcOffset to 2.0, the source value at the next-step phase argument is
    // dcOffset + amplitude * sin(...). At small simTime, sin(...) is close
    // to zero, so the pos node moves close to 2.0V — strict directional
    // assertion is that v after differs from v before by approximately the
    // dcOffset delta.
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sine", amplitude: 1, frequency: 1000, phase: 0, dcOffset: 0,
      }),
    });
    const ce = getAcsrcCircuitElement(fix);
    const node = getAcsrcPosNode(fix);
    const before = fix.engine.getNodeVoltage(node);
    fix.coordinator.setComponentProperty(ce, "dcOffset", 2.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(node);
    expect(after).not.toBeCloseTo(before, 6);
    expect(after - before).toBeGreaterThan(1.5);
  });

  it("hotload_amplitude_changes_pos_node", () => {
    // Build at phase=π/2 so sin(phase) = 1 and v ≈ amplitude. Doubling
    // amplitude doubles the contribution of sin(phase) to the source value.
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sine", amplitude: 1, frequency: 1000, phase: Math.PI / 2, dcOffset: 0,
      }),
    });
    const ce = getAcsrcCircuitElement(fix);
    const node = getAcsrcPosNode(fix);
    const before = fix.engine.getNodeVoltage(node);
    fix.coordinator.setComponentProperty(ce, "amplitude", 4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(node);
    expect(after).not.toBeCloseTo(before, 6);
    // amplitude grew 1 → 4: the sin-driven swing increases.
    expect(Math.abs(after)).toBeGreaterThan(Math.abs(before));
  });

  it("hotload_frequency_changes_pos_node", () => {
    // Doubling frequency at the same simTime doubles the phase argument
    // 2π*f*t, shifting the instantaneous sin(...) value (unless t happens
    // to land on a sin zero — choose phase=0 so simTime ≠ 0 produces a
    // non-zero sin sample whose value is frequency-dependent).
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sine", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
      }),
    });
    const ce = getAcsrcCircuitElement(fix);
    const node = getAcsrcPosNode(fix);
    const before = fix.engine.getNodeVoltage(node);
    fix.coordinator.setComponentProperty(ce, "frequency", 5000);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(node);
    expect(after).not.toBe(before);
  });

  it("hotload_phase_changes_pos_node", () => {
    // At phase=0, simTime≈0 → sin ≈ 0. Hot-loading phase to π/2 shifts the
    // argument by 90°: sin(2πft + π/2) = cos(2πft) ≈ 1 at small t → v ≈ amp.
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sine", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
      }),
    });
    const ce = getAcsrcCircuitElement(fix);
    const node = getAcsrcPosNode(fix);
    const before = fix.engine.getNodeVoltage(node);
    fix.coordinator.setComponentProperty(ce, "phase", Math.PI / 2);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(node);
    expect(after).not.toBeCloseTo(before, 6);
    // After the π/2 shift the source approaches +amp at small simTime.
    expect(after).toBeGreaterThan(4);
  });

  it("hotload_riseTime_changes_square_pos_node", () => {
    // Square mode with phase=0 at the rising edge: increasing riseTime makes
    // the trapezoidal ramp slower, so the post-step voltage during the ramp
    // is lower than with the default 1ps riseTime that snaps to V2 instantly.
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "square", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
        riseTime: 1e-12, fallTime: 1e-12,
      }),
    });
    const ce = getAcsrcCircuitElement(fix);
    const node = getAcsrcPosNode(fix);
    const before = fix.engine.getNodeVoltage(node);
    fix.coordinator.setComponentProperty(ce, "riseTime", 1e-4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(node);
    expect(after).not.toBe(before);
  });

  it("hotload_fallTime_changes_square_pos_node", () => {
    // Square mode: fallTime stretches the trailing-edge ramp. Changing it
    // shifts the per-step value once the engine has advanced into the fall
    // region of the cycle.
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "square", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
        riseTime: 1e-12, fallTime: 1e-12,
      }),
    });
    const ce = getAcsrcCircuitElement(fix);
    const node = getAcsrcPosNode(fix);
    // Step a few times into the cycle so we're past the rising-edge region.
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(node);
    fix.coordinator.setComponentProperty(ce, "fallTime", 2e-4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(node);
    expect(after).not.toBe(before);
  });

  it("hotload_noiseSampleTime_changes_noise_breakpoint_schedule", () => {
    // Cat 4 derived-state-recompute pattern: noiseSampleTime gates the
    // breakpoint registration schedule in noise mode. Hot-loading a new
    // sample period changes the schedule, which changes both the count of
    // step-end records that land on breakpoint boundaries AND the per-step
    // observable on the source's pos node (because fresh Gaussian draws are
    // taken at different simTimes).
    //
    // Directional / not-equal pattern per Cat 4 contract:
    //   1) after !== before: the hot-load took effect at the simulator
    //      surface (no-op silent-ignore of the param fails this).
    //   2) Stepping under the new sample period yields >= 1 step record in
    //      the convergence log (the schedule actually advanced the engine
    //      under the new schedule, not just at the old breakpoint cadence).
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "noise", amplitude: 1, frequency: 1000, phase: 0, dcOffset: 0,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    const ce = getAcsrcCircuitElement(fix);
    const node = getAcsrcPosNode(fix);

    const before = fix.engine.getNodeVoltage(node);
    fix.coordinator.setComponentProperty(ce, "noiseSampleTime", 1e-5);
    // Run enough steps under the new schedule to accumulate breakpoint
    // landings (at least several sample-period boundaries).
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(node);

    // (1) Directional: hot-load propagated to the simulator observable.
    expect(after).not.toBe(before);
    // (2) Schedule observable: under the new noiseSampleTime, the engine
    // recorded step-end records — the hot-loaded schedule actually drove
    // the timestep controller forward.
    const log = fix.coordinator.getConvergenceLog()!;
    expect(log.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Category 8 — Breakpoints (T1)
//
// AcVoltageSource registers breakpoints in acceptStep for square / triangle /
// sawtooth waveforms (and noise via TRNOISE). Square at 1kHz with default
// 1ps riseTime/fallTime: the first edge breakpoint is at t = riseTime ≈ 1ps,
// then halfPeriod = 0.5ms, etc. The engine's timestep controller must land
// on the registered breakpoint exactly.
// ===========================================================================

describe("AcVoltageSource breakpoints (T1)", () => {
  it("square_halfperiod_breakpoint_lands_exactly", () => {
    const T_HALF = 0.5e-3; // halfPeriod for 1kHz square
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "square", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
        riseTime: 1e-12, fallTime: 1e-12,
      }),
      params: { tStop: T_HALF * 2, maxTimeStep: T_HALF / 4 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    while (
      fix.coordinator.simTime !== null &&
      fix.coordinator.simTime < T_HALF * 1.5
    ) {
      fix.coordinator.step();
    }
    const log = fix.coordinator.getConvergenceLog()!;
    // Step record's end-of-step time is simTime + acceptedDt (the entry time
    // plus the final accepted timestep). The breakpoint controller must land
    // bit-exact on T_HALF.
    const bpStep = log.find(s => s.simTime + s.acceptedDt === T_HALF);
    expect(bpStep).toBeDefined();
  });

  it("triangle_halfperiod_breakpoint_lands_exactly", () => {
    const T_HALF = 0.5e-3;
    const fix = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "triangle", amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0,
      }),
      params: { tStop: T_HALF * 2, maxTimeStep: T_HALF / 4 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    while (
      fix.coordinator.simTime !== null &&
      fix.coordinator.simTime < T_HALF * 1.5
    ) {
      fix.coordinator.step();
    }
    const log = fix.coordinator.getConvergenceLog()!;
    const bpStep = log.find(s => s.simTime + s.acceptedDt === T_HALF);
    expect(bpStep).toBeDefined();
  });
});

// ===========================================================================
// Category 2-numerical / 3 / 5 — Harness sessions (T3)
//
// One describe()/session per .dts. Sessions open in beforeAll, runs go in
// the FIRST it() per session-sharing rules, dispose in afterAll. Gated on
// canonical dllAvailable() via describeIfDll.
// ===========================================================================

describeIfDll("AcVoltageSource square-RC paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_SQUARE_RC,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_square_rc", async () => {
    await session.runTransient(0, 4e-3, 5e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_square_rc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_square_rc", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("AcVoltageSource sine-RC paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_SINE_RC,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_sine_rc", async () => {
    await session.runTransient(0, 5e-3, 5e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_sine_rc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_sine_rc", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("AcVoltageSource triangle-RC paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_TRIANGLE_RC,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_triangle_rc", async () => {
    await session.runTransient(0, 5e-3, 5e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_triangle_rc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_triangle_rc", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("AcVoltageSource sawtooth-RC paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_SAWTOOTH_RC,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_sawtooth_rc", async () => {
    await session.runTransient(0, 5e-3, 5e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_sawtooth_rc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_sawtooth_rc", () => {
    session.compareAllAttempts();
  });
});
