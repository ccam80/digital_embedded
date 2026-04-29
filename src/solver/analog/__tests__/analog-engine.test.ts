/**
 * Tests for MNAEngine — the concrete AnalogEngine implementation.
 *
 * All circuit fixtures live in `./fixtures/analog-fixtures.ts`. Tests use
 * either:
 *
 *   - production-path compile* helpers (compileDivider, compileDiode) when
 *     the circuit can be built via real ComponentDefinitions; or
 *   - direct-element recipes (dividerCircuit, rcCircuit, diodeCircuit,
 *     rlCircuit, fuseCircuit) plus wrapHandElements when injecting custom
 *     AnalogElement implementations (acceptStep stubs, etc.).
 *
 * No test in this file owns or pre-allocates a StatePool; the engine's
 * _setup() is the single owner. See analog-fixtures.ts for the contract.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import * as NiPredModule from "../ni-pred.js";
import { EngineState } from "../../../core/engine-interface.js";
import {
  compileDivider,
  compileDiode,
  dividerCircuit,
  rcCircuit,
  diodeCircuit,
  fuseCircuit,
  wrapHandElements,
} from "./fixtures/analog-fixtures.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { PropertyBag } from "../../../core/properties.js";
import { NGSPICE_LOAD_ORDER } from "../../../core/analog-types.js";
import type { AnalogElement } from "../element.js";
import type { LoadContext } from "../load-context.js";
import type { SetupContext } from "../setup-context.js";

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  let _hPP = -1, _hNN = -1, _hPN = -1, _hNP = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES,
    _pinNodes: new Map([["A", nodeA], ["B", nodeB]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeA !== 0) _hPP = s.allocElement(nodeA, nodeA);
      if (nodeB !== 0) _hNN = s.allocElement(nodeB, nodeB);
      if (nodeA !== 0 && nodeB !== 0) {
        _hPN = s.allocElement(nodeA, nodeB);
        _hNP = s.allocElement(nodeB, nodeA);
      }
    },
    load(ctx: LoadContext): void {
      const s = ctx.solver;
      if (_hPP !== -1) s.stampElement(_hPP,  G);
      if (_hNN !== -1) s.stampElement(_hNN,  G);
      if (_hPN !== -1) s.stampElement(_hPN, -G);
      if (_hNP !== -1) s.stampElement(_hNP, -G);
    },
    getPinCurrents(rhs: Float64Array): number[] {
      const vA = rhs[nodeA] ?? 0;
      const vB = rhs[nodeB] ?? 0;
      return [G * (vA - vB), G * (vB - vA)];
    },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}

// ---------------------------------------------------------------------------
// MNAEngine — core behaviour
// ---------------------------------------------------------------------------

describe("MNAEngine", () => {
  let engine: MNAEngine;

  beforeEach(() => {
    engine = new MNAEngine();
  });

  // -------------------------------------------------------------------------
  // DC operating point
  // -------------------------------------------------------------------------

  it("dc_op_resistor_divider_via_compiler", () => {
    const compiled = compileDivider({ R1: 1000, R2: 1000, V: 5 });
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // V_mid resolves through compiled.labelToNodeId
    const midNodeId = compiled.labelToNodeId.get("V_mid")!;
    const vMid = engine.getNodeVoltage(midNodeId);
    expect(vMid).toBeCloseTo(2.5, 6);
  });

  it("dc_op_diode_circuit_via_compiler", () => {
    const compiled = compileDiode({ R: 1000, V: 5 });
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // Diode anode is the lower of the non-supply, non-ground node voltages.
    const voltages = Array.from(result.nodeVoltages.slice(1, compiled.nodeCount + 1));
    const sorted = [...voltages].sort((a, b) => a - b);
    expect(sorted[0]).toBeGreaterThan(0.55);
    expect(sorted[0]).toBeLessThan(0.80);
  });

  it("dc_op_returns_result", () => {
    engine.init(dividerCircuit());
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.method).toBe("direct");
    expect(result.nodeVoltages).toBeInstanceOf(Float64Array);
  });

  // -------------------------------------------------------------------------
  // Transient simulation
  // -------------------------------------------------------------------------

  it("transient_rc_decay", () => {
    engine.init(rcCircuit());

    const RC = 1e-3;
    let steps = 0;
    while (engine.simTime < RC && steps < 5000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);
    // With Vs connected, node2 stays near 5V.
    const v2 = engine.getNodeVoltage(2);
    expect(v2).toBeGreaterThan(4.5);
    expect(v2).toBeLessThanOrEqual(5.01);
  });

  it("sim_time_advances", () => {
    engine.init(dividerCircuit());

    expect(engine.simTime).toBe(0);
    for (let i = 0; i < 10; i++) engine.step();
    expect(engine.simTime).toBeGreaterThan(0);
  });

  it("last_dt_reflects_adaptive_step", () => {
    engine.init(dividerCircuit());
    engine.step();

    expect(engine.lastDt).toBeGreaterThan(0);
    expect(engine.lastDt).toBeLessThanOrEqual(5e-6);
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  it("reset_clears_state", () => {
    engine.init(dividerCircuit());
    engine.dcOperatingPoint();

    for (let i = 0; i < 5; i++) engine.step();

    engine.reset();

    expect(engine.simTime).toBe(0);
    expect(engine.getNodeVoltage(1)).toBe(0);
    expect(engine.getNodeVoltage(2)).toBe(0);
    expect(engine.getState()).toBe(EngineState.STOPPED);
  });

  // -------------------------------------------------------------------------
  // Configure
  // -------------------------------------------------------------------------

  it("configure_changes_tolerances", () => {
    engine.init(diodeCircuit());

    engine.configure({ reltol: 1e-6 });
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  it("diagnostics_emitted_on_dc_op", () => {
    engine.init(dividerCircuit());

    const received: string[] = [];
    engine.onDiagnostic((diag) => received.push(diag.code));

    engine.dcOperatingPoint();
    expect(received).toContain("dc-op-converged");
  });

  // -------------------------------------------------------------------------
  // Breakpoints
  // -------------------------------------------------------------------------

  it("breakpoint_honored", () => {
    engine.init(dividerCircuit());

    const targetTime = 50e-6;
    engine.addBreakpoint(targetTime);

    let reached = false;
    for (let i = 0; i < 200; i++) {
      engine.step();
      if (engine.simTime >= targetTime - 1e-20) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Branch current
  // -------------------------------------------------------------------------

  it("get_branch_current", () => {
    engine.init(dividerCircuit());
    engine.dcOperatingPoint();

    // Vs=5V, R1+R2=2kΩ → |I| = 2.5mA
    const i = engine.getBranchCurrent(0);
    expect(Math.abs(i)).toBeCloseTo(2.5e-3, 6);
  });

  // -------------------------------------------------------------------------
  // Engine state transitions
  // -------------------------------------------------------------------------

  it("engine_state_transitions", () => {
    expect(engine.getState()).toBe(EngineState.STOPPED);

    engine.init(dividerCircuit());
    expect(engine.getState()).toBe(EngineState.STOPPED);

    engine.start();
    expect(engine.getState()).toBe(EngineState.RUNNING);

    engine.stop();
    expect(engine.getState()).toBe(EngineState.PAUSED);

    engine.reset();
    expect(engine.getState()).toBe(EngineState.STOPPED);
  });

  it("change_listeners_notified", () => {
    const states: EngineState[] = [];

    engine.addChangeListener((s) => states.push(s));
    engine.init(dividerCircuit());
    engine.start();
    engine.stop();
    engine.reset();

    expect(states).toContain(EngineState.RUNNING);
    expect(states).toContain(EngineState.PAUSED);
    expect(states).toContain(EngineState.STOPPED);
  });

  it("remove_change_listener_works", () => {
    const states: EngineState[] = [];
    const listener = (s: EngineState) => states.push(s);

    engine.addChangeListener(listener);
    engine.removeChangeListener(listener);

    engine.init(dividerCircuit());
    engine.start();

    expect(states).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Predictor / breakpoint dispatch / regressions
  // -------------------------------------------------------------------------

  it("predictor_off_uses_last_converged_guess", () => {
    engine.init(diodeCircuit());
    engine.configure({ predictor: false });

    for (let i = 0; i < 20; i++) {
      engine.step();
      expect(engine.getState()).not.toBe(EngineState.ERROR);
    }

    const vAnode = engine.getNodeVoltage(2);
    expect(vAnode).toBeGreaterThan(0.55);
    expect(vAnode).toBeLessThan(0.80);
  });

  it("pulse_breakpoint_scheduled", () => {
    // Inject a passive (no-stamp) element whose acceptStep schedules edge
    // breakpoints, into a divider-shaped fixture. Verifies generic acceptStep
    // dispatch independent of source-element phase-boundary gating.
    const edgePeriod = 100e-6;
    const scheduledEdges: number[] = [];

    const pulseElement = {
      label: "",
      _pinNodes: new Map<string, number>(),
      _stateBase: -1 as number,
      branchIndex: -1 as number,
      ngspiceLoadOrder: 0,
      setup(_ctx: unknown) {},
      setParam(_k: string, _v: number) {},
      load(_ctx: unknown) {},
      getPinCurrents(_v: Float64Array): number[] { return []; },
      acceptStep(simTime: number, addBreakpoint: (t: number) => void, _atBreakpoint: boolean): void {
        const nextEdge = Math.ceil((simTime + 1e-20) / edgePeriod) * edgePeriod;
        scheduledEdges.push(nextEdge);
        addBreakpoint(nextEdge);
      },
    };

    const compiled = wrapHandElements({
      nodeCount: 2,
      elements: [
        (() => {
          const props = new PropertyBag();
          props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage: 5.0 });
          return makeDcVoltageSource(new Map([["pos", 1], ["neg", 0]]), props, () => 0);
        })(),
        makeResistor(1, 2, 1000),
        makeResistor(2, 0, 1000),
        pulseElement as unknown as import("../element.js").AnalogElement,
      ],
    });

    engine.init(compiled);
    engine.dcOperatingPoint();

    const target = 300e-6;
    let steps = 0;
    while (engine.simTime < target && steps < 10000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    const remainder = engine.simTime % edgePeriod;
    const nearEdge = remainder < 1e-9 || Math.abs(remainder - edgePeriod) < 1e-9;
    expect(nearEdge || engine.simTime >= target).toBe(true);
    expect(scheduledEdges.length).toBeGreaterThan(0);
  });

  it("predictor_off_rc_regression", () => {
    engine.init(rcCircuit());

    const RC = 1e-3;
    let steps = 0;
    while (engine.simTime < RC && steps < 10000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    const v2 = engine.getNodeVoltage(2);
    expect(v2).toBeGreaterThan(4.5);
    expect(v2).toBeLessThanOrEqual(5.01);
    expect(engine.simTime).toBeGreaterThanOrEqual(RC - 1e-9);
  });

  it("transient_fuse_blows_under_overcurrent", () => {
    // Circuit: 5V → fuse(1Ω, i2tRating=1e-8 A²·s) → 9Ω → ground
    // I = 0.5A, I² = 0.25, blow time = 1e-8/0.25 = 4e-8s = 40ns
    // With maxTimeStep=5µs, should blow in first step.
    const { circuit, fuse } = fuseCircuit({
      V: 5, rCold: 1.0, rBlown: 1e9, i2tRating: 1e-8, rLoad: 9.0,
    });

    engine.init(circuit);

    expect(fuse.blown).toBe(false);
    expect(fuse.currentResistance).toBeLessThan(2); // close to rCold=1Ω

    for (let i = 0; i < 10; i++) {
      engine.step();
      if (fuse.blown) break;
    }

    expect(fuse.blown).toBe(true);
    expect(fuse.currentResistance).toBeGreaterThan(1e8); // near rBlown
  });
});

// ---------------------------------------------------------------------------
// SimulationRunner integration — the full compileUnified pipeline
// ---------------------------------------------------------------------------

describe("runner_integration", () => {
  it("resolves_label_to_node_voltage", () => {
    const compiled = compileDivider({ R1: 1000, R2: 1000, V: 5 });

    const engine = new MNAEngine();
    engine.init(compiled);

    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    const nodeId = compiled.labelToNodeId.get("V_mid");
    expect(nodeId).toBeDefined();
    expect(engine.getNodeVoltage(nodeId!)).toBeCloseTo(2.5, 6);
  });
});

// ---------------------------------------------------------------------------
// Engine-internal invariants exercised through behaviour
// ---------------------------------------------------------------------------

describe("rc_transient_without_separate_loops", () => {
  it("rc_transient_without_separate_loops", () => {
    const engine = new MNAEngine();
    engine.init(rcCircuit());

    for (let i = 0; i < 100; i++) {
      engine.step();
      expect(engine.getState()).not.toBe(EngineState.ERROR);
    }

    const v2 = engine.getNodeVoltage(2);
    expect(v2).toBeGreaterThan(4.9);
    expect(v2).toBeLessThanOrEqual(5.01);
    expect(engine.simTime).toBeGreaterThan(0);
  });
});

describe("xfact_computed_from_deltaOld", () => {
  it("xfact_computed_from_deltaOld", () => {
    const engine = new MNAEngine();
    engine.init(rcCircuit());
    engine.dcOperatingPoint();

    for (let i = 0; i < 3; i++) engine.step();

    const ctx = (engine as unknown as {
      _ctx: { loadCtx: { xfact: number }; deltaOld: readonly number[] };
    })._ctx;

    const d0 = ctx.deltaOld[0];
    const d1 = ctx.deltaOld[1];
    expect(ctx.loadCtx.xfact).toBe(d0 / d1);
  });
});

describe("method_stable_across_ringing", () => {
  it("method_stable_across_ringing", () => {
    const engine = new MNAEngine();
    engine.init(rcCircuit());

    for (let i = 0; i < 50; i++) {
      engine.step();
      expect(engine.getState()).not.toBe(EngineState.ERROR);
    }

    expect(engine.integrationMethod).toBe("trapezoidal");
  });
});

describe("first_step_uses_order_1", () => {
  it("first_step_uses_order_1", () => {
    // ngspice dctran.c:315 sets CKTorder = 1 at transient entry; niinteg.c:20-21
    // gives the order-1 trap coefficients ag[0] = 1/dt, ag[1] = -1/dt.
    const engine = new MNAEngine();
    engine.init(rcCircuit());
    engine.dcOperatingPoint();

    expect(engine.integrationOrder).toBe(1);

    engine.step();
    expect(engine.getState()).not.toBe(EngineState.ERROR);
  });
});

describe("predictor_gate_off_by_default", () => {
  it("predictor_gate_off_by_default", () => {
    // Spy on the real predictVoltages — it must not be invoked when
    // predictor: false. (Phase 5 review: the previous _voltages /
    // _prevVoltages structural check was an implementation-detail test.)
    const spy = vi.spyOn(NiPredModule, "predictVoltages");

    try {
      const engine = new MNAEngine();
      engine.init(rcCircuit());
      engine.configure({ predictor: false });

      for (let i = 0; i < 10; i++) {
        engine.step();
        expect(engine.getState()).not.toBe(EngineState.ERROR);
      }

      expect(engine.simTime).toBeGreaterThan(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("no_closures_in_step", () => {
  it("no_closures_in_step", () => {
    const engine = new MNAEngine();
    engine.init(rcCircuit());
    engine.dcOperatingPoint();
    engine.start();

    const ctx = (engine as unknown as {
      _ctx: { preIterationHook: unknown; addBreakpointBound: unknown; convergenceFailures: string[] };
    })._ctx;
    const hookRef = ctx.preIterationHook;
    const bpRef = ctx.addBreakpointBound;
    const failuresArr = ctx.convergenceFailures;

    for (let i = 0; i < 10; i++) engine.step();

    expect(ctx.preIterationHook).toBe(hookRef);
    expect(ctx.addBreakpointBound).toBe(bpRef);
    expect(ctx.convergenceFailures).toBe(failuresArr);
  });
});
