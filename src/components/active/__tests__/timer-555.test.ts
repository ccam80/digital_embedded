/**
 * Tests for the 555 Timer IC composite analog model.
 *
 * Test handling per A1 §Test handling rule (spec/architectural-alignment.md §A1):
 *   - Post-load observable state (engine-agnostic, node voltages): KEPT
 *   - Parameter-plumbing (setParam on vDrop, rDischarge): KEPT
 *   - Engine-agnostic interface contracts: KEPT
 *   Timer555 parity (C4.5)::timer555_load_transient_parity
 *                                                bit-exact stamp assertions with
 *                                                 hand-computed NGSPICE_* expected values
 *
 * Kept tests:
 *   Timer555::internal_divider_voltages          observable node voltage (CTRL = 2/3 VCC)
 *                                                 via runDcOp; engine-agnostic.
 *   Astable::oscillates_at_correct_frequency     transient observable (transition count)
 *   Astable::duty_cycle                          transient observable (time-weighted)
 *   Monostable::pulse_width                      transient observable (pulse timing)
 *   Monostable::retrigger_ignored_during_pulse   transient observable (pulse width bound)
 *
 * Astable circuit:
 *   VCC=5V  R1  node_a  R2  node_b(THR=TRIG)  C  GND
 *   DIS connected to node_a (between R1 and R2)
 *   OUT connected to node_out
 *   CTRL connected to node_ctrl (floating via internal divider)
 *   RST connected to VCC
 *
 * The voltage divider inside the 555 sets CTRL  2/3 VCC = 3.33V.
 * Charging: through R1+R2, from 1/3 VCC to 2/3 VCC.
 * Discharging: through R2 (DIS discharges through R2), from 2/3 VCC to 1/3 VCC.
 * f = 1.44 / ((R1 + 2·R2) · C)
 * duty = (R1 + R2) / (R1 + 2·R2)
 */

import { describe, it, expect } from "vitest";
import { Timer555Definition } from "../timer-555.js";
import { PropertyBag } from "../../../core/properties.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMER555_MODEL_PARAM_KEYS = new Set(["vDrop", "rDischarge"]);

function makeProps(overrides: Record<string, number | string> = {}): PropertyBag {
  const modelParams: Record<string, number> = { vDrop: 1.5, rDischarge: 10 };
  const staticEntries: [string, number | string][] = [["model", "bipolar"]];
  for (const [k, v] of Object.entries(overrides)) {
    if (TIMER555_MODEL_PARAM_KEYS.has(k)) {
      modelParams[k] = v as number;
    } else {
      staticEntries.push([k, v]);
    }
  }
  const bag = new PropertyBag(staticEntries);
  bag.replaceModelParams(modelParams);
  return bag;
}

// ---------------------------------------------------------------------------
// Timer555 unit tests  observable DC operating point
// ---------------------------------------------------------------------------

describe("Timer555", () => {
  it("internal_divider_voltages", () => {
    /**
     * Facade migration: DC-OP only. VCC=5V fixed, CTRL floating.
     * Internal divider sets CTRL ≈ 2/3 VCC = 3.333V ±1%.
     *
     * Circuit: DcVoltageSource(vcc) + Timer555(t) + Ground.
     * THR, TRIG, DIS, OUT left open (connected to ground for stability).
     * RST tied to VCC node via wire.
     * Read CTRL from "t:CTRL".
     */
    const VCC = 5;

    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vcc", type: "DcVoltageSource", props: { voltage: VCC, label: "vcc" } },
        { id: "t",   type: "Timer555",        props: { label: "t" } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vcc:pos", "t:VCC"],
        ["vcc:neg", "gnd:out"],
        ["t:GND",   "gnd:out"],
        ["t:RST",   "t:VCC"],
        ["t:TRIG",  "gnd:out"],
        ["t:THR",   "gnd:out"],
        ["t:DIS",   "gnd:out"],
        ["t:OUT",   "gnd:out"],
      ],
    });

    const coordinator = facade.compile(circuit);
    const result = facade.getDcOpResult();

    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const sigs = facade.readAllSignals(coordinator);
    const vCtrl = sigs["t:CTRL"] ?? 0;
    const vExpected = VCC * (2 / 3);
    const errorPct = Math.abs(vCtrl - vExpected) / vExpected * 100;

    // CTRL ≈ 2/3 VCC ±1%
    expect(errorPct).toBeLessThan(1);

    // Trigger reference = CTRL/2 ≈ 1/3 VCC ±1%
    const vTrigRef = vCtrl * 0.5;
    const vTrigExpected = VCC / 3;
    const trigErrorPct = Math.abs(vTrigRef - vTrigExpected) / vTrigExpected * 100;
    expect(trigErrorPct).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Astable (free-running) transient tests
// ---------------------------------------------------------------------------



/**
 * Facade helper: build the astable 555 circuit.
 * VCC → R1 → node_a(DIS) → R2 → node_b(THR=TRIG) → C → GND
 * OUT connected to labeled "out" resistor probe (high-Z, 1MΩ to GND).
 */
function buildAstableFacade(R1: number, R2: number, C: number, VCC: number): {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
  readOut: () => number;
} {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "vcc",  type: "DcVoltageSource", props: { voltage: VCC, label: "vcc" } },
      { id: "t",    type: "Timer555",        props: { label: "t" } },
      { id: "r1",   type: "Resistor",        props: { resistance: R1 } },
      { id: "r2",   type: "Resistor",        props: { resistance: R2 } },
      { id: "cap",  type: "Capacitor",       props: { capacitance: C } },
      { id: "rout", type: "Resistor",        props: { resistance: 1e6 } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vcc:pos", "t:VCC"],
      ["vcc:neg", "gnd:out"],
      ["t:GND",   "gnd:out"],
      ["t:RST",   "t:VCC"],
      // R1: VCC → DIS junction
      ["t:VCC",   "r1:A"],
      ["r1:B",    "t:DIS"],
      // R2: DIS junction → cap/THR/TRIG node
      ["t:DIS",   "r2:A"],
      ["r2:B",    "t:THR"],
      ["t:THR",   "t:TRIG"],
      // Capacitor: THR node → GND
      ["t:THR",   "cap:pos"],
      ["cap:neg", "gnd:out"],
      // OUT probe: OUT → 1MΩ → GND (high-Z read)
      ["t:OUT",   "rout:A"],
      ["rout:B",  "gnd:out"],
    ],
  });
  const coordinator = facade.compile(circuit);
  const readOut = () => facade.readAllSignals(coordinator)["t:OUT"] ?? 0;
  return { facade, coordinator, readOut };
}

describe("Astable", () => {
  it("oscillates_at_correct_frequency", async () => {
    /**
     * Facade migration: sample OUT at 500 points per period over 6.5 periods,
     * count threshold crossings in the last 5 periods.
     * Expected: f = 1.44/((R1+2R2)·C) ≈ 6.857 Hz ±10%.
     */
    const R1 = 1000;
    const R2 = 10000;
    const C  = 10e-6;
    const VCC = 5;

    const fExpected = 1.44 / ((R1 + 2 * R2) * C);
    const periodExpected = 1 / fExpected;
    const midVoltage = VCC / 2;

    const { coordinator, readOut } = buildAstableFacade(R1, R2, C, VCC);

    // Warmup: 1.5 periods; then measure: 5 periods.
    const warmupTime = periodExpected * 1.5;
    const measureTime = 5 * periodExpected;
    const totalTime = warmupTime + measureTime;

    // Sample at 500 pts/period across the full run.
    const samplesPerPeriod = 500;
    const totalSamples = Math.ceil(totalTime / periodExpected) * samplesPerPeriod;
    const times = Array.from({ length: totalSamples }, (_, i) =>
      (i + 1) * (totalTime / totalSamples),
    );

    const samples = await coordinator.sampleAtTimes(times, readOut);

    // Find sample index at warmup boundary.
    const warmupIdx = Math.floor(warmupTime / totalTime * totalSamples);

    // Count threshold crossings in the measurement window.
    let transitions = 0;
    let prev = samples[warmupIdx] as number;
    for (let i = warmupIdx + 1; i < samples.length; i++) {
      const v = samples[i] as number;
      if ((prev < midVoltage && v >= midVoltage) ||
          (prev >= midVoltage && v < midVoltage)) {
        transitions++;
      }
      prev = v;
    }

    // 5 complete steady-state periods = 10 transitions ±2.
    expect(transitions).toBeGreaterThanOrEqual(8);
    expect(transitions).toBeLessThanOrEqual(12);

    const fMeasured = transitions / 2 / measureTime;
    const fError = Math.abs(fMeasured - fExpected) / fExpected;
    // Within 10%
    expect(fError).toBeLessThan(0.10);
  });

  it("duty_cycle", async () => {
    /**
     * Facade migration: sample OUT at fine resolution, accumulate time-weighted
     * duty over 5 steady-state periods.
     * Expected duty = (R1+R2)/(R1+2R2) = 11/21 ≈ 52.38% ±5%.
     */
    const R1 = 1000;
    const R2 = 10000;
    const C  = 10e-6;
    const VCC = 5;

    const dutyExpected = (R1 + R2) / (R1 + 2 * R2);
    const fExpected = 1.44 / ((R1 + 2 * R2) * C);
    const periodExpected = 1 / fExpected;
    const midVoltage = VCC / 2;

    const { coordinator, readOut } = buildAstableFacade(R1, R2, C, VCC);

    // Warmup: 1.5 periods; measure: 5 periods.
    const warmupTime = periodExpected * 1.5;
    const measureTime = 5 * periodExpected;
    const totalTime = warmupTime + measureTime;

    // 500 pts/period for duty-cycle resolution.
    const samplesPerPeriod = 500;
    const totalSamples = Math.ceil(totalTime / periodExpected) * samplesPerPeriod;
    const dt = totalTime / totalSamples;
    const times = Array.from({ length: totalSamples }, (_, i) =>
      (i + 1) * dt,
    );

    const samples = await coordinator.sampleAtTimes(times, readOut);

    // Accumulate time-weighted high/low in measurement window.
    const warmupIdx = Math.floor(warmupTime / totalTime * totalSamples);
    let timeHigh = 0;
    let timeLow = 0;
    for (let i = warmupIdx; i < samples.length; i++) {
      const v = samples[i] as number;
      if (v > midVoltage) {
        timeHigh += dt;
      } else {
        timeLow += dt;
      }
    }

    const totalMeasured = timeHigh + timeLow;
    expect(totalMeasured).toBeGreaterThan(0);

    const dutyMeasured = timeHigh / totalMeasured;
    const dutyError = Math.abs(dutyMeasured - dutyExpected) / dutyExpected;

    // Within 5% relative error
    expect(dutyError).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Monostable (one-shot) transient tests
// ---------------------------------------------------------------------------

/**
 * Facade helper: build the monostable 555 circuit.
 * VCC → R → THR(=DIS) → C → GND. TRIG driven by labeled DcVoltageSource "trig".
 * OUT readable via "t:OUT".
 */
function buildMonostableFacade(R: number, Cval: number, VCC: number): {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
  readOut: () => number;
  setTrig: (v: number) => void;
} {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "vcc",  type: "DcVoltageSource", props: { voltage: VCC,  label: "vcc"  } },
      { id: "trig", type: "DcVoltageSource", props: { voltage: VCC,  label: "trig" } },
      { id: "t",    type: "Timer555",        props: { label: "t" } },
      { id: "r",    type: "Resistor",        props: { resistance: R } },
      { id: "cap",  type: "Capacitor",       props: { capacitance: Cval } },
      { id: "rout", type: "Resistor",        props: { resistance: 1e6 } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vcc:pos",  "t:VCC"],
      ["vcc:neg",  "gnd:out"],
      ["t:GND",    "gnd:out"],
      ["t:RST",    "t:VCC"],
      // R: VCC → THR/DIS node
      ["t:VCC",    "r:A"],
      ["r:B",      "t:THR"],
      ["t:THR",    "t:DIS"],
      // Capacitor: THR → GND
      ["t:THR",    "cap:pos"],
      ["cap:neg",  "gnd:out"],
      // TRIG source: controlled externally via setSignal("trig", v)
      ["trig:pos", "t:TRIG"],
      ["trig:neg", "gnd:out"],
      // OUT probe
      ["t:OUT",    "rout:A"],
      ["rout:B",   "gnd:out"],
    ],
  });
  const coordinator = facade.compile(circuit);
  const readOut = () => facade.readAllSignals(coordinator)["t:OUT"] ?? 0;
  const setTrig = (v: number) => facade.setSignal(coordinator, "trig", v);
  return { facade, coordinator, readOut, setTrig };
}

describe("Monostable", () => {
  it("pulse_width", async () => {
    /**
     * Facade migration: monostable 555.
     * 1. Compile circuit with TRIG=VCC (idle).
     * 2. Set TRIG=0.5V, advance one small step to fire comparator.
     * 3. Release TRIG=VCC.
     * 4. Sample OUT over 3×tWidth to find pulse start/end.
     * Expected: tWidth = 1.1×R×C = 110ms ±10%.
     */
    const R    = 100e3;
    const Cval = 1e-6;
    const VCC  = 5;
    const tWidthExpected = 1.1 * R * Cval; // 110ms

    const { facade, coordinator, readOut, setTrig } = buildMonostableFacade(R, Cval, VCC);

    // DC-OP converges with TRIG high (idle state).
    const dcResult = facade.getDcOpResult();
    expect(dcResult).not.toBeNull();
    expect(dcResult!.converged).toBe(true);

    // Apply trigger pulse: TRIG → 0.5V (< 1/3 VCC = 1.67V).
    setTrig(0.5);
    await coordinator.stepToTime(1e-4); // one small step to register trigger

    // Release trigger.
    setTrig(VCC);

    // Sample OUT at 200 pts/tWidth over 3×tWidth to locate pulse edges.
    const measureEnd = tWidthExpected * 3;
    const totalSamples = 600; // 200 per tWidth
    const times = Array.from({ length: totalSamples }, (_, i) =>
      (coordinator.simTime ?? 0) + (i + 1) * (measureEnd / totalSamples),
    );
    const samples = await coordinator.sampleAtTimes(times, readOut);

    // Post-process: find rising edge (pulseStart) and falling edge (pulseEnd).
    const midVoltage = VCC / 2;
    let pulseStart = -1;
    let pulseEnd = -1;
    let prev = samples[0] as number;

    for (let i = 1; i < samples.length; i++) {
      const v = samples[i] as number;
      const t = times[i]!;
      if (prev <= midVoltage && v > midVoltage && pulseStart < 0) {
        pulseStart = t;
      }
      if (prev > midVoltage && v <= midVoltage && pulseStart >= 0) {
        pulseEnd = t;
        break;
      }
      prev = v;
    }

    expect(pulseEnd).toBeGreaterThan(0);

    const tWidthMeasured = pulseEnd - pulseStart;
    const tWidthError = Math.abs(tWidthMeasured - tWidthExpected) / tWidthExpected;

    // Within 10% (timestep quantization at comparator crossings)
    expect(tWidthError).toBeLessThan(0.10);
  });

  it("retrigger_ignored_during_pulse", async () => {
    /**
     * Facade migration: standard 555 retrigger immunity.
     * Applying a second trigger during the output pulse must NOT extend it.
     * Strategy: step through 3 phases using stepToTime + setSignal.
     *   Phase 1: trigger, advance tiny step.
     *   Phase 2: release, sample to find pulse start; advance to 30% of tWidth.
     *   Phase 3: retrigger, advance to 40%; release; sample remaining to find end.
     */
    const R    = 100e3;
    const Cval = 1e-6;
    const VCC  = 5;
    const tWidthExpected = 1.1 * R * Cval; // 110ms

    const { facade, coordinator, readOut, setTrig } = buildMonostableFacade(R, Cval, VCC);

    facade.getDcOpResult(); // ensure DC-OP has run

    // Phase 1: fire trigger.
    setTrig(0.5);
    await coordinator.stepToTime(1e-4);
    setTrig(VCC);

    // Phase 2: sample to find pulse start, then advance to 30% point.
    const phase2End = tWidthExpected * 1.5;
    const phase2Samples = 300;
    const phase2Times = Array.from({ length: phase2Samples }, (_, i) =>
      (coordinator.simTime ?? 0) + (i + 1) * (phase2End / phase2Samples),
    );
    const phase2 = await coordinator.sampleAtTimes(phase2Times, readOut);

    const midVoltage = VCC / 2;
    let pulseStart = -1;
    let prev2 = phase2[0] as number;
    for (let i = 1; i < phase2.length; i++) {
      const v = phase2[i] as number;
      if (prev2 <= midVoltage && v > midVoltage && pulseStart < 0) {
        pulseStart = phase2Times[i]!;
      }
      prev2 = v;
    }

    // Apply retrigger at ~30% through the expected pulse.
    const retriggerAt = pulseStart >= 0 ? pulseStart + tWidthExpected * 0.3 : (coordinator.simTime ?? 0) + tWidthExpected * 0.3;
    await coordinator.stepToTime(retriggerAt);
    setTrig(0.5); // retrigger

    // Release at ~40%.
    const releaseAt = pulseStart >= 0 ? pulseStart + tWidthExpected * 0.4 : retriggerAt + tWidthExpected * 0.1;
    await coordinator.stepToTime(releaseAt);
    setTrig(VCC);

    // Phase 3: sample remaining to find pulse end.
    const phase3End = tWidthExpected * 3;
    const phase3Samples = 400;
    const phase3Times = Array.from({ length: phase3Samples }, (_, i) =>
      (coordinator.simTime ?? 0) + (i + 1) * (phase3End / phase3Samples),
    );
    const phase3 = await coordinator.sampleAtTimes(phase3Times, readOut);

    let pulseEnd = -1;
    let prev3 = phase3[0] as number;
    for (let i = 1; i < phase3.length; i++) {
      const v = phase3[i] as number;
      if (prev3 > midVoltage && v <= midVoltage && pulseStart >= 0) {
        pulseEnd = phase3Times[i]!;
        break;
      }
      prev3 = v;
    }

    expect(pulseEnd).toBeGreaterThan(0);

    const tWidthMeasured = pulseEnd - pulseStart;

    // Pulse width must NOT be extended beyond 1.1×RC × 1.15 (15% margin).
    expect(tWidthMeasured).toBeLessThan(tWidthExpected * 1.15);
    // Pulse must have the normal width (within 10%).
    const tWidthError = Math.abs(tWidthMeasured - tWidthExpected) / tWidthExpected;
    expect(tWidthError).toBeLessThan(0.10);
  });
});
