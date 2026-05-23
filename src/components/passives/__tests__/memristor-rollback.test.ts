import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { MemristorElement, MEMRISTOR_SCHEMA } from "../memristor.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";

const SLOT_W = MEMRISTOR_SCHEMA.indexOf.get("W")!;

const DTS_DC_RESISTIVE = path.resolve("src/components/passives/__tests__/fixtures/memristor-canon-dc-resistive.dts");
const DTS_AC_DRIFT     = path.resolve("src/components/passives/__tests__/fixtures/memristor-canon-ac-drift.dts");

function findMemristor(elements: ReadonlyArray<unknown>): MemristorElement {
  const idx = elements.findIndex((el) => el instanceof MemristorElement);
  if (idx < 0) throw new Error("MemristorElement not found in compiled circuit");
  return elements[idx] as MemristorElement;
}

function getMemCe(fix: ReturnType<typeof buildFixture>) {
  const wrapperIdx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "mem",
  );
  if (wrapperIdx < 0) throw new Error("mem wrapper not found");
  const ce = fix.circuit.elementToCircuitElement.get(wrapperIdx);
  if (ce === undefined) throw new Error("mem CircuitElement not in map");
  return ce;
}

// ---------------------------------------------------------------------------
// Cat 1 — Initialization (T1)
// ---------------------------------------------------------------------------

describe("Memristor initialization (T1)", () => {
  it("init_w_seeded_to_initialState_after_warm_start", () => {
    // initialState=0.5 propagates through the bottom-of-load seed idiom into
    // s0[W]. After warm-start, s0[W] must equal the seeded boot constant.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0.5 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const mem = findMemristor(fix.circuit.elements);
    expect(fix.pool.state0[mem._stateBase + SLOT_W]).toBe(0.5);
  });

  it("init_w_clamped_when_initialState_above_one", () => {
    // initialState=1.5 → clamped to 1 by the constructor.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 1.5 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const mem = findMemristor(fix.circuit.elements);
    expect(fix.pool.state0[mem._stateBase + SLOT_W]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 — DC operating point analytical (T1)
// ---------------------------------------------------------------------------

describe("Memristor DCOP analytical (T1)", () => {
  it("dcop_resistive_divider_at_initial_state", () => {
    // At initialState=0.5: R(w) = rOn*w + rOff*(1-w) = 100*0.5 + 16000*0.5 = 8050 Ω.
    // V_supply=1V across (R_mem + R_load) = (8050 + 1000) = 9050 Ω.
    // Node between mem and rl: V = V_supply * R_load / (R_mem + R_load)
    //   = 1 * 1000 / 9050 ≈ 0.11049723756906078 V.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0.5 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const midNodeId = fix.circuit.labelToNodeId.get("mem:neg")!;
    expect(fix.engine.getNodeVoltage(midNodeId)).toBeCloseTo(1000 / 9050, 6);
  });

  it("dcop_w_at_zero_presents_rOff", () => {
    // At initialState=0: R(w) = rOff = 16000 Ω.
    // Node between mem and rl: V = 1 * 1000 / 17000 ≈ 0.05882352941...
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const midNodeId = fix.circuit.labelToNodeId.get("mem:neg")!;
    expect(fix.engine.getNodeVoltage(midNodeId)).toBeCloseTo(1000 / 17000, 6);
  });

  it("dcop_w_at_one_presents_rOn", () => {
    // At initialState=1: R(w) = rOn = 100 Ω.
    // Node between mem and rl: V = 1 * 1000 / 1100 ≈ 0.90909090909...
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 1 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const midNodeId = fix.circuit.labelToNodeId.get("mem:neg")!;
    expect(fix.engine.getNodeVoltage(midNodeId)).toBeCloseTo(1000 / 1100, 6);
  });
});

// ---------------------------------------------------------------------------
// Cat 2-numerical / Cat 3 / Cat 5 — paired vs ngspice (T3)
// runTransient lives in the FIRST it() of each describeIfDll block.
// ---------------------------------------------------------------------------

describeIfDll("Memristor paired vs ngspice — DC resistive (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_DC_RESISTIVE, analysis: "tran", tStop: 1e-4, maxStep: 1e-5 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_dc_resistive", async () => {
    await session.runTransient(0, 1e-4, 1e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_dc_resistive", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_dc_resistive", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Memristor paired vs ngspice — AC drift (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_AC_DRIFT, analysis: "tran", tStop: 2e-3, maxStep: 1e-5 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_ac_drift", async () => {
    await session.runTransient(0, 2e-3, 1e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_ac_drift", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_ac_drift", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("Memristor parameter hot-load (T1)", () => {
  it("hotload_rOn_changes_node_voltage_when_w_high", () => {
    // At initialState=1, R(w) = rOn. Doubling rOn from 100→500 lowers the
    // current and lowers V_load. Closed-form:
    //   before: V_load = V * R_load / (rOn_before + R_load) = 1 * 1000 / 1100
    //   after : V_load = V * R_load / (rOn_after  + R_load) = 1 * 1000 / 1500
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 1 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const midNodeId = fix.circuit.labelToNodeId.get("mem:neg")!;
    const before = fix.engine.getNodeVoltage(midNodeId);
    expect(before).toBeCloseTo(1000 / 1100, 6);

    fix.coordinator.setComponentProperty(getMemCe(fix), "rOn", 500);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(midNodeId);
    expect(after).toBeCloseTo(1000 / 1500, 4);
    expect(after).not.toBeCloseTo(before, 4);
  });

  it("hotload_rOff_changes_node_voltage_when_w_zero", () => {
    // At initialState=0, R(w) = rOff. Halving rOff from 16000→8000 raises
    // the current and raises V_load. Closed-form:
    //   before: V_load = 1 * 1000 / (16000 + 1000)
    //   after : V_load = 1 * 1000 / (8000  + 1000)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const midNodeId = fix.circuit.labelToNodeId.get("mem:neg")!;
    const before = fix.engine.getNodeVoltage(midNodeId);
    expect(before).toBeCloseTo(1000 / 17000, 6);

    fix.coordinator.setComponentProperty(getMemCe(fix), "rOff", 8000);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(midNodeId);
    expect(after).toBeCloseTo(1000 / 9000, 4);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_initialState_resets_w_and_changes_node_voltage", () => {
    // At initialState=0 (rOff dominant). Hot-loading initialState=1 (rOn
    // dominant) writes both s0[W] and s1[W] so the next load() stamps the
    // rOn conductance. Closed-form:
    //   before: V_load = 1 * 1000 / 17000
    //   after : V_load = 1 * 1000 / 1100
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0 } },
          { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
          { id: "gnd", type: "Ground",         props: { label: "gnd" } },
        ],
        connections: [
          ["vs:pos",  "mem:pos"],
          ["mem:neg", "rl:pos"],
          ["rl:neg",  "gnd:out"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const midNodeId = fix.circuit.labelToNodeId.get("mem:neg")!;
    const before = fix.engine.getNodeVoltage(midNodeId);
    expect(before).toBeCloseTo(1000 / 17000, 6);

    fix.coordinator.setComponentProperty(getMemCe(fix), "initialState", 1);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(midNodeId);
    expect(after).toBeCloseTo(1000 / 1100, 4);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_mobility_changes_w_drift_rate", () => {
    // dw/dt ∝ mobility · rOn / D² · i · f_p(w). Raising mobility 100x
    // accelerates drift. Run transient steps with mobility default vs
    // mobility 100x and assert |Δw| differs (not equal-close).
    const connections: [string, string][] = [
      ["vs:pos",  "mem:pos"],
      ["mem:neg", "rl:pos"],
      ["rl:neg",  "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ];
    const buildSpec = (mobility?: number) => ({
      components: [
        { id: "vs",  type: "AcVoltageSource", props: { label: "vs",  amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0, waveform: "sine" } },
        { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0.5 ,
          ...(mobility !== undefined ? { mobility } : {}) } },
        { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
        { id: "gnd", type: "Ground",         props: { label: "gnd" } },
      ],
      connections,
    });

    const fixDefault = buildFixture({
      build: (_r, facade) => facade.build(buildSpec()),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    const fixHigh = buildFixture({
      build: (_r, facade) => facade.build(buildSpec(1e-12)),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });

    const memDefault = findMemristor(fixDefault.circuit.elements);
    const memHigh    = findMemristor(fixHigh.circuit.elements);
    const w0Default = fixDefault.pool.state1[memDefault._stateBase + SLOT_W];
    const w0High    = fixHigh.pool.state1[memHigh._stateBase + SLOT_W];

    for (let i = 0; i < 50; i++) {
      fixDefault.coordinator.step();
      fixHigh.coordinator.step();
    }

    const wDefault = fixDefault.pool.state1[memDefault._stateBase + SLOT_W];
    const wHigh    = fixHigh.pool.state1[memHigh._stateBase + SLOT_W];
    const driftDefault = Math.abs(wDefault - w0Default);
    const driftHigh    = Math.abs(wHigh    - w0High);
    expect(driftHigh).toBeGreaterThan(driftDefault);
  });

  it("hotload_deviceLength_changes_w_drift_rate", () => {
    // dw/dt ∝ 1/D². Halving deviceLength 4x'es the drift rate.
    const connections: [string, string][] = [
      ["vs:pos",  "mem:pos"],
      ["mem:neg", "rl:pos"],
      ["rl:neg",  "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ];
    const buildSpec = (deviceLength?: number) => ({
      components: [
        { id: "vs",  type: "AcVoltageSource", props: { label: "vs",  amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0, waveform: "sine" } },
        { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0.5,
          ...(deviceLength !== undefined ? { deviceLength } : {}) } },
        { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
        { id: "gnd", type: "Ground",         props: { label: "gnd" } },
      ],
      connections,
    });

    const fixDefault = buildFixture({
      build: (_r, facade) => facade.build(buildSpec()),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    const fixShort = buildFixture({
      build: (_r, facade) => facade.build(buildSpec(5e-9)),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });

    const memDefault = findMemristor(fixDefault.circuit.elements);
    const memShort   = findMemristor(fixShort.circuit.elements);
    const w0Default = fixDefault.pool.state1[memDefault._stateBase + SLOT_W];
    const w0Short   = fixShort.pool.state1[memShort._stateBase + SLOT_W];

    for (let i = 0; i < 50; i++) {
      fixDefault.coordinator.step();
      fixShort.coordinator.step();
    }

    const wDefault = fixDefault.pool.state1[memDefault._stateBase + SLOT_W];
    const wShort   = fixShort.pool.state1[memShort._stateBase + SLOT_W];
    const driftDefault = Math.abs(wDefault - w0Default);
    const driftShort   = Math.abs(wShort   - w0Short);
    expect(driftShort).toBeGreaterThan(driftDefault);
  });

  it("hotload_windowOrder_changes_w_drift_profile", () => {
    // f_p(w) = 1 - (2w-1)^(2p). At w=0.5, f_p(0.5)=1 for any p (max drift).
    // Off the midpoint (w=0.5+ε), higher p flattens the window slower than
    // lower p — so over a transient that ranges away from 0.5 the cumulative
    // drift differs between p=1 and p=5.
    const connections: [string, string][] = [
      ["vs:pos",  "mem:pos"],
      ["mem:neg", "rl:pos"],
      ["rl:neg",  "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ];
    const buildSpec = (windowOrder?: number) => ({
      components: [
        { id: "vs",  type: "AcVoltageSource", props: { label: "vs",  amplitude: 5, frequency: 1000, phase: 0, dcOffset: 0, waveform: "sine" } },
        { id: "mem", type: "Memristor",      props: { label: "mem", model: "behavioral", rOn: 100, rOff: 16000, initialState: 0.7,
          ...(windowOrder !== undefined ? { windowOrder } : {}) } },
        { id: "rl",  type: "Resistor",       props: { label: "rl",  resistance: 1000 } },
        { id: "gnd", type: "Ground",         props: { label: "gnd" } },
      ],
      connections,
    });

    const fixP1 = buildFixture({
      build: (_r, facade) => facade.build(buildSpec(1)),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    const fixP5 = buildFixture({
      build: (_r, facade) => facade.build(buildSpec(5)),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });

    for (let i = 0; i < 50; i++) {
      fixP1.coordinator.step();
      fixP5.coordinator.step();
    }

    const memP1 = findMemristor(fixP1.circuit.elements);
    const memP5 = findMemristor(fixP5.circuit.elements);
    const wP1 = fixP1.pool.state1[memP1._stateBase + SLOT_W];
    const wP5 = fixP5.pool.state1[memP5._stateBase + SLOT_W];
    expect(wP1).not.toBeCloseTo(wP5, 6);
  });
});
