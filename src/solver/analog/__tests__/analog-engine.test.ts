/** Tests for MNAEngine — exercised through buildFixture. */

import { describe, it, expect, vi } from "vitest";
import { buildFixture } from "./fixtures/build-fixture.js";
import { EngineState } from "../../../core/engine-interface.js";
import * as NiPredModule from "../ni-pred.js";
import { AnalogFuseElement } from "../../../components/passives/analog-fuse.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentSpec } from "../../../headless/netlist-types.js";

// ---------------------------------------------------------------------------
// Circuit recipes — declarative builds via facade.build
// ---------------------------------------------------------------------------

function buildDivider(
  facade: DefaultSimulatorFacade,
  opts: { R1?: number; R2?: number; V?: number; addProbe?: boolean } = {},
): Circuit {
  const { R1 = 1000, R2 = 1000, V = 5, addProbe = false } = opts;
  const components: ComponentSpec[] = [
    { id: "Vs",  type: "DcVoltageSource", props: { label: "Vs", voltage: V } },
    { id: "R1",  type: "Resistor",        props: { label: "R1", resistance: R1 } },
    { id: "R2",  type: "Resistor",        props: { label: "R2", resistance: R2 } },
    { id: "GND", type: "Ground",          props: { label: "GND" } },
  ];
  const connections: Array<[string, string]> = [
    ["Vs:pos", "R1:pos"],
    ["R1:neg", "R2:pos"],
    ["R2:neg", "GND:out"],
    ["Vs:neg", "GND:out"],
  ];
  if (addProbe) {
    components.push({ id: "Probe1", type: "Probe", props: { label: "V_mid" } });
    connections.push(["Probe1:in", "R1:neg"]);
  }
  return facade.build({ components, connections });
}

function buildRC(
  facade: DefaultSimulatorFacade,
  opts: { R?: number; C?: number; V?: number } = {},
): Circuit {
  const { R = 1000, C = 1e-6, V = 5 } = opts;
  return facade.build({
    components: [
      { id: "Vs",  type: "DcVoltageSource", props: { label: "Vs", voltage: V } },
      { id: "R1",  type: "Resistor",        props: { label: "R1", resistance: R } },
      { id: "C1",  type: "Capacitor",       props: { label: "C1", capacitance: C } },
      { id: "GND", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["Vs:pos", "R1:pos"],
      ["R1:neg", "C1:pos"],
      ["C1:neg", "GND:out"],
      ["Vs:neg", "GND:out"],
    ],
  });
}

function buildDiodeCircuit(
  facade: DefaultSimulatorFacade,
  opts: { R?: number; V?: number } = {},
): Circuit {
  const { R = 1000, V = 5 } = opts;
  return facade.build({
    components: [
      { id: "Vs",  type: "DcVoltageSource", props: { label: "Vs", voltage: V } },
      { id: "R1",  type: "Resistor",        props: { label: "R1", resistance: R } },
      { id: "D1",  type: "Diode",           props: { label: "D1" } },
      { id: "GND", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["Vs:pos", "R1:pos"],
      ["R1:neg", "D1:A"],
      ["D1:K",   "GND:out"],
      ["Vs:neg", "GND:out"],
    ],
  });
}

function buildFuseCircuit(
  facade: DefaultSimulatorFacade,
  opts: { V?: number; rCold?: number; rBlown?: number; i2tRating?: number; rLoad?: number },
): Circuit {
  const { V = 5, rCold = 1.0, rBlown = 1e9, i2tRating = 1e-8, rLoad = 9.0 } = opts;
  return facade.build({
    components: [
      { id: "Vs",  type: "DcVoltageSource", props: { label: "Vs", voltage: V } },
      { id: "Fu",  type: "Fuse",            props: { label: "Fu", model: "behavioral", rCold, rBlown, i2tRating } },
      { id: "RL",  type: "Resistor",        props: { label: "RL", resistance: rLoad } },
      { id: "GND", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["Vs:pos",  "Fu:out1"],
      ["Fu:out2", "RL:pos"],
      ["RL:neg",  "GND:out"],
      ["Vs:neg",  "GND:out"],
    ],
  });
}

function findFuseElement(elements: ReadonlyArray<unknown>): AnalogFuseElement {
  const fuse = elements.find((el) => el instanceof AnalogFuseElement);
  if (fuse === undefined) throw new Error("AnalogFuseElement not found in compiled circuit");
  return fuse as AnalogFuseElement;
}

// ---------------------------------------------------------------------------
// MNAEngine — core behaviour
// ---------------------------------------------------------------------------

describe("MNAEngine", () => {
  // ----- DC operating point ------------------------------------------------

  it("dc_op_resistor_divider", () => {
    const fix = buildFixture({ build: (_r, f) => buildDivider(f, { R1: 1000, R2: 1000, V: 5 }) });
    const result = fix.engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    const midNode = fix.circuit.labelToNodeId.get("R1:neg")!;
    expect(fix.engine.getNodeVoltage(midNode)).toBeCloseTo(2.5, 6);
  });

  it("dc_op_diode_circuit", () => {
    const fix = buildFixture({ build: (_r, f) => buildDiodeCircuit(f, { R: 1000, V: 5 }) });
    const result = fix.engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    const vAnode = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    expect(vAnode).toBeGreaterThan(0.55);
    expect(vAnode).toBeLessThan(0.80);
  });

  it("dc_op_returns_result", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    const result = fix.engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.method).toBe("direct");
    expect(result.nodeVoltages).toBeInstanceOf(Float64Array);
  });

  // ----- Transient simulation ---------------------------------------------

  it("transient_rc_decay", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    const RC = 1e-3;
    let steps = 0;
    while (fix.engine.simTime < RC && steps < 5000) {
      fix.engine.step();
      steps++;
      if (fix.engine.getState() === EngineState.ERROR) break;
    }

    expect(fix.engine.getState()).not.toBe(EngineState.ERROR);
    expect(fix.engine.simTime).toBeGreaterThan(0);
    const vCap = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("C1:pos")!);
    expect(vCap).toBeGreaterThan(4.5);
    expect(vCap).toBeLessThanOrEqual(5.01);
  });

  it("sim_time_advances", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    const t0 = fix.engine.simTime;
    for (let i = 0; i < 10; i++) fix.engine.step();
    expect(fix.engine.simTime).toBeGreaterThan(t0);
  });

  it("last_dt_reflects_adaptive_step", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    fix.engine.step();
    expect(fix.engine.lastDt).toBeGreaterThan(0);
  });

  // ----- Reset ------------------------------------------------------------

  it("reset_clears_state", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    for (let i = 0; i < 5; i++) fix.engine.step();

    fix.engine.reset();

    expect(fix.engine.simTime).toBe(0);
    expect(fix.engine.getNodeVoltage(1)).toBe(0);
    expect(fix.engine.getNodeVoltage(2)).toBe(0);
    expect(fix.engine.getState()).toBe(EngineState.STOPPED);
  });

  // ----- Configure --------------------------------------------------------

  it("configure_changes_tolerances", () => {
    const fix = buildFixture({ build: (_r, f) => buildDiodeCircuit(f) });

    fix.engine.configure({ reltol: 1e-6 });
    const result = fix.engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
  });

  // ----- Diagnostics -------------------------------------------------------

  it("diagnostics_emitted_on_dc_op", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });

    const received: string[] = [];
    fix.engine.onDiagnostic((diag) => received.push(diag.code));

    fix.engine.dcOperatingPoint();
    expect(received).toContain("dc-op-converged");
  });

  // ----- Breakpoints -------------------------------------------------------

  it("breakpoint_honored", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });

    const targetTime = 50e-6;
    fix.engine.addBreakpoint(targetTime);

    let reached = false;
    for (let i = 0; i < 200; i++) {
      fix.engine.step();
      if (fix.engine.simTime >= targetTime - 1e-20) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
  });

  // ----- Branch current ----------------------------------------------------

  it("get_branch_current", () => {
    const fix = buildFixture({ build: (_r, f) => buildDivider(f, { R1: 1000, R2: 1000, V: 5 }) });
    fix.engine.dcOperatingPoint();

    // Vs=5V, R1+R2=2kΩ → |I| = 2.5mA. Branch 0 = source's branch row.
    const i = fix.engine.getBranchCurrent(0);
    expect(Math.abs(i)).toBeCloseTo(2.5e-3, 6);
  });

  // ----- Engine state transitions ------------------------------------------

  it("engine_state_transitions", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    fix.engine.reset();
    expect(fix.engine.getState()).toBe(EngineState.STOPPED);

    fix.engine.start();
    expect(fix.engine.getState()).toBe(EngineState.RUNNING);

    fix.engine.stop();
    expect(fix.engine.getState()).toBe(EngineState.PAUSED);

    fix.engine.reset();
    expect(fix.engine.getState()).toBe(EngineState.STOPPED);
  });

  it("change_listeners_notified", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    const states: EngineState[] = [];

    fix.engine.addChangeListener((s) => states.push(s));
    fix.engine.start();
    fix.engine.stop();
    fix.engine.reset();

    expect(states).toContain(EngineState.RUNNING);
    expect(states).toContain(EngineState.PAUSED);
    expect(states).toContain(EngineState.STOPPED);
  });

  it("remove_change_listener_works", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    const states: EngineState[] = [];
    const listener = (s: EngineState) => states.push(s);

    fix.engine.addChangeListener(listener);
    fix.engine.removeChangeListener(listener);

    fix.engine.start();

    expect(states).toHaveLength(0);
  });

  // ----- Predictor / regressions -------------------------------------------

  it("predictor_off_uses_last_converged_guess", () => {
    const fix = buildFixture({ build: (_r, f) => buildDiodeCircuit(f) });
    fix.engine.configure({ predictor: false });

    for (let i = 0; i < 20; i++) {
      fix.engine.step();
      expect(fix.engine.getState()).not.toBe(EngineState.ERROR);
    }

    const vAnode = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("D1:A")!);
    expect(vAnode).toBeGreaterThan(0.55);
    expect(vAnode).toBeLessThan(0.80);
  });

  it("predictor_off_rc_regression", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });

    const RC = 1e-3;
    let steps = 0;
    while (fix.engine.simTime < RC && steps < 10000) {
      fix.engine.step();
      steps++;
      if (fix.engine.getState() === EngineState.ERROR) break;
    }

    expect(fix.engine.getState()).not.toBe(EngineState.ERROR);
    const vCap = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("C1:pos")!);
    expect(vCap).toBeGreaterThan(4.5);
    expect(vCap).toBeLessThanOrEqual(5.01);
    expect(fix.engine.simTime).toBeGreaterThanOrEqual(RC - 1e-9);
  });

  // ----- Generic acceptStep dispatch on a non-source element ---------------
  // The fuse blowing requires the engine to dispatch acceptStep() on a
  // non-source element. If acceptStep dispatch regresses (e.g. only sources
  // get called), the fuse never flips _intact and the test fails.

  it("transient_fuse_blows_under_overcurrent", () => {
    const fix = buildFixture({
      build: (_r, f) => buildFuseCircuit(f, {
        V: 5, rCold: 1.0, rBlown: 1e9, i2tRating: 1e-8, rLoad: 9.0,
      }),
    });
    const fuse = findFuseElement(fix.circuit.elements);

    for (let i = 0; i < 10; i++) {
      fix.engine.step();
      if (fuse.blown) break;
    }

    expect(fuse.blown).toBe(true);
    expect(fuse.currentResistance).toBeGreaterThan(1e8);
  });
});

// ---------------------------------------------------------------------------
// Label resolution end-to-end through the unified compile pipeline
// ---------------------------------------------------------------------------

describe("runner_integration", () => {
  it("resolves_label_to_node_voltage", () => {
    const fix = buildFixture({
      build: (_r, f) => buildDivider(f, { R1: 1000, R2: 1000, V: 5, addProbe: true }),
    });
    const result = fix.engine.dcOperatingPoint();
    expect(result.converged).toBe(true);

    const nodeId = fix.circuit.labelToNodeId.get("V_mid");
    expect(nodeId).toBeDefined();
    expect(fix.engine.getNodeVoltage(nodeId!)).toBeCloseTo(2.5, 6);
  });
});

// ---------------------------------------------------------------------------
// Engine-internal invariants exercised through behaviour
// ---------------------------------------------------------------------------

describe("rc_transient_without_separate_loops", () => {
  it("rc_transient_without_separate_loops", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });

    for (let i = 0; i < 100; i++) {
      fix.engine.step();
      expect(fix.engine.getState()).not.toBe(EngineState.ERROR);
    }

    const vCap = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("C1:pos")!);
    expect(vCap).toBeGreaterThan(4.9);
    expect(vCap).toBeLessThanOrEqual(5.01);
    expect(fix.engine.simTime).toBeGreaterThan(0);
  });
});

describe("method_stable_across_ringing", () => {
  it("method_stable_across_ringing", () => {
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });

    for (let i = 0; i < 50; i++) {
      fix.engine.step();
      expect(fix.engine.getState()).not.toBe(EngineState.ERROR);
    }

    expect(fix.engine.integrationMethod).toBe("trapezoidal");
  });
});

describe("first_step_uses_order_1", () => {
  it("first_step_uses_order_1", () => {
    // ngspice dctran.c:315 sets CKTorder = 1 at transient entry; niinteg.c:20-21
    // gives the order-1 trap coefficients ag[0] = 1/dt, ag[1] = -1/dt.
    const fix = buildFixture({ build: (_r, f) => buildRC(f) });
    fix.engine.dcOperatingPoint();

    expect(fix.engine.integrationOrder).toBe(1);

    fix.engine.step();
    expect(fix.engine.getState()).not.toBe(EngineState.ERROR);
  });
});

describe("MNAEngine accessors are populated after dcop", () => {
  it("MNAEngine accessors are populated after dcop", () => {
    const fix = buildFixture({ build: (_r, f) => buildDivider(f, { R1: 1000, R2: 1000, V: 5 }) });
    fix.engine.dcOperatingPoint();
    expect(fix.engine.statePool).toBeDefined();
  });
});

describe("predictor_gate_off_by_default", () => {
  it("predictor_gate_off_by_default", () => {
    // predictVoltages must not be invoked when predictor: false.
    const spy = vi.spyOn(NiPredModule, "predictVoltages");

    try {
      const fix = buildFixture({
        build: (_r, f) => buildRC(f),
        params: { predictor: false },
      });

      for (let i = 0; i < 10; i++) {
        fix.engine.step();
        expect(fix.engine.getState()).not.toBe(EngineState.ERROR);
      }

      expect(fix.engine.simTime).toBeGreaterThan(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
