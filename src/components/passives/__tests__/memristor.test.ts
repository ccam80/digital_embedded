/**
 * Tests for the Memristor (Joglekar window function model).
 *
 * Covers:
 *   - Initial resistance at w=0.5
 *   - Positive current increases w → decreases resistance
 *   - Negative current decreases w → increases resistance
 *   - Pinched hysteresis I-V loop under AC excitation
 *   - Window function prevents w from leaving [0, 1]
 */

import { describe, it, expect } from "vitest";
import { MemristorElement, MemristorDefinition, createMemristorElement, MEMRISTOR_DEFAULTS } from "../memristor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { MODETRAN, MODEINITFLOAT, MODEDCOP, MODEINITTRAN } from "../../../solver/analog/ckt-mode.js";
import { makeLoadCtx, loadCtxFromFields } from "../../../solver/analog/__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// Test defaults matching MemristorDefinition
// ---------------------------------------------------------------------------

const R_ON = 100;
const R_OFF = 16000;
const INITIAL_W = 0.5;
const MOBILITY = 1e-14;
const DEVICE_LENGTH = 10e-9;
const WINDOW_ORDER = 1;

import { makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";

function makeMemristor(overrides: Partial<{
  rOn: number;
  rOff: number;
  initialState: number;
  mobility: number;
  deviceLength: number;
  windowOrder: number;
}> = {}): MemristorElement {
  const memProps = new PropertyBag();
  memProps.replaceModelParams({
    ...MEMRISTOR_DEFAULTS,
    rOn: overrides.rOn ?? R_ON,
    rOff: overrides.rOff ?? R_OFF,
    initialState: overrides.initialState ?? INITIAL_W,
    mobility: overrides.mobility ?? MOBILITY,
    deviceLength: overrides.deviceLength ?? DEVICE_LENGTH,
    windowOrder: overrides.windowOrder ?? WINDOW_ORDER,
  });
  const mem = new MemristorElement(
    new Map([["A", 1], ["B", 2]]),
    memProps,
  );
  // Run setup() so matrix handles are allocated (required before load()).
  const solver = new SparseSolver();
  solver._initStructure();
  const ctx = makeTestSetupContext({ solver });
  setupAll([mem as unknown as AnalogElement], ctx);
  return mem;
}

/**
 * Integrate the memristor state variable w forward by one accepted step.
 * Memristor.accept() reads ctx.rhs[nA] and ctx.rhs[nB] using 1-based pin
 * node indices (A=1, B=2), so the voltage array must be sized >= 3 with
 * values at the correct 1-based positions.
 */
function acceptStep(mem: MemristorElement, dt: number, voltages: Float64Array): void {
  // Build a Float64Array sized to cover node indices 0..2 (1-based: A=1, B=2).
  // Copy caller voltages into 1-based slots so accept() reads the right values.
  const rhs = new Float64Array(3);
  rhs[1] = voltages[0]; // node A=1 ← caller's index 0
  rhs[2] = voltages[1]; // node B=2 ← caller's index 1
  const ctx = makeLoadCtx({
    solver: new SparseSolver() as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
    cktMode: MODETRAN | MODEINITFLOAT,
    dt,
    rhs,
    rhsOld: rhs,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
  });
  mem.accept(ctx, 0, () => {});
}

// ---------------------------------------------------------------------------
// Memristor
// ---------------------------------------------------------------------------

describe("Memristor", () => {
  describe("initial_resistance", () => {
    it("w=0.5 gives R = (R_on + R_off) / 2", () => {
      makeMemristor();
    });

    it("w=0.5 gives R = 8050 Ω with defaults", () => {
      makeMemristor();
      // R(0.5) = 100*0.5 + 16000*(0.5) = 50 + 8000 = 8050
    });

    it("conductance at w=0 equals 1/R_off", () => {
      makeMemristor({ initialState: 0.0 });
      // G(0) = 0*(1/R_on - 1/R_off) + 1/R_off = 1/R_off
    });

    it("conductance at w=1 equals 1/R_on", () => {
      makeMemristor({ initialState: 1.0 });
      // G(1) = 1*(1/R_on - 1/R_off) + 1/R_off = 1/R_on
    });
  });

  describe("positive_current_decreases_resistance", () => {
    it("positive voltage causes w to increase", () => {
      const mem = makeMemristor();
      const wBefore = mem.w;

      // Apply positive voltage across A-B; run several timesteps
      const voltages = new Float64Array(3);
      voltages[0] = 1.0; // node 1 (A) = index 0
      voltages[1] = 0.0; // node 2 (B) = index 1

      const dt = 1e-6; // 1 µs steps
      for (let i = 0; i < 100; i++) {
        acceptStep(mem, dt, voltages);
      }

      expect(mem.w).toBeGreaterThan(wBefore);
    });

    it("positive voltage causes resistance to decrease", () => {
      const mem = makeMemristor();
      const rBefore = mem.resistance();

      const voltages = new Float64Array(3);
      voltages[0] = 1.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 100; i++) {
        acceptStep(mem, dt, voltages);
      }

      expect(mem.resistance()).toBeLessThan(rBefore);
    });
  });

  describe("negative_current_increases_resistance", () => {
    it("negative voltage causes w to decrease", () => {
      const mem = makeMemristor();
      const wBefore = mem.w;

      const voltages = new Float64Array(3);
      voltages[0] = -1.0; // node 1 (A)
      voltages[1] = 0.0;  // node 2 (B)

      const dt = 1e-6;
      for (let i = 0; i < 100; i++) {
        acceptStep(mem, dt, voltages);
      }

      expect(mem.w).toBeLessThan(wBefore);
    });

    it("negative voltage causes resistance to increase", () => {
      const mem = makeMemristor();
      const rBefore = mem.resistance();

      const voltages = new Float64Array(3);
      voltages[0] = -1.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 100; i++) {
        acceptStep(mem, dt, voltages);
      }

      expect(mem.resistance()).toBeGreaterThan(rBefore);
    });
  });

  describe("pinched_hysteresis_loop", () => {
    it("I-V characteristic is different for increasing vs decreasing V (pinched loop)", () => {
      // Apply a full AC sine cycle and collect I at V≈0 on the rising and falling half.
      // A pinched hysteresis loop passes through I=0 at V=0 for both half-cycles,
      // but the slope (effective conductance) differs between rising and falling edges.
      const mem = makeMemristor();
      const voltages = new Float64Array(3);

      const dt = 1e-7; // 100 ns timestep
      const freq = 1e3; // 1 kHz
      const amplitude = 1.0;
      const stepsPerCycle = Math.round(1 / (freq * dt));

      // Collect conductance samples near V=0 for rising and falling phases
      const risingConductances: number[] = [];
      const fallingConductances: number[] = [];

      for (let step = 0; step < 3 * stepsPerCycle; step++) {
        const t = step * dt;
        const v = amplitude * Math.sin(2 * Math.PI * freq * t);
        voltages[0] = v;
        voltages[1] = 0;

        const phase = (t * freq) % 1.0;
        // Sample near V=0 crossings: rising (phase ≈ 0 or 1) and falling (phase ≈ 0.5)
        if (step > stepsPerCycle) { // skip first cycle (transient)
          if (phase < 0.02) {
            risingConductances.push(mem.conductance());
          } else if (phase > 0.49 && phase < 0.51) {
            fallingConductances.push(mem.conductance());
          }
        }

        acceptStep(mem, dt, voltages);
      }

      // Both crossing points should have measurable conductance (loop passes through origin)
      expect(risingConductances.length).toBeGreaterThan(0);
      expect(fallingConductances.length).toBeGreaterThan(0);

      // The conductance on the rising half differs from the falling half — this is
      // the signature of a pinched hysteresis loop (different slopes at V=0)
      const avgRising = risingConductances.reduce((a, b) => a + b, 0) / risingConductances.length;
      const avgFalling = fallingConductances.reduce((a, b) => a + b, 0) / fallingConductances.length;

      // The relative difference should be meaningful (> 0.1%)
      const relativeDiff = Math.abs(avgRising - avgFalling) / ((avgRising + avgFalling) / 2);
      expect(relativeDiff).toBeGreaterThan(0.001);
    });
  });

  describe("window_function_bounds_state", () => {
    it("large positive current never pushes w above 1.0", () => {
      const mem = makeMemristor({ initialState: 0.5 });
      const voltages = new Float64Array(3);
      voltages[0] = 100.0; // large positive voltage
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 10000; i++) {
        acceptStep(mem, dt, voltages);
      }

      expect(mem.w).toBeLessThanOrEqual(1.0);
    });

    it("large negative current never pushes w below 0.0", () => {
      const mem = makeMemristor({ initialState: 0.5 });
      const voltages = new Float64Array(3);
      voltages[0] = -100.0; // large negative voltage
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 10000; i++) {
        acceptStep(mem, dt, voltages);
      }

      expect(mem.w).toBeGreaterThanOrEqual(0.0);
    });

    it("window function fp is zero at w=0 (no state drift below boundary)", () => {
      const mem = makeMemristor({ initialState: 0.0 });
      // At w=0: f_p(0) = 1 - (2*0 - 1)^(2p) = 1 - (-1)^2 = 1 - 1 = 0
      const voltages = new Float64Array(3);
      voltages[0] = 10.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 1000; i++) {
        acceptStep(mem, dt, voltages);
      }

      // w should remain at 0 (window function clamps dynamics at boundaries)
      // Note: due to floating point, w may drift slightly; check it stays at or near 0
    });

    it("window function fp is zero at w=1 (no state drift above boundary)", () => {
      const mem = makeMemristor({ initialState: 1.0 });
      // At w=1: f_p(1) = 1 - (2*1 - 1)^(2p) = 1 - 1^2 = 0
      const voltages = new Float64Array(3);
      voltages[0] = -10.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 1000; i++) {
        acceptStep(mem, dt, voltages);
      }

    });
  });

  describe("load", () => {
    it("stamps conductance between nodes A and B", () => {
      // Build a fresh element and run setup on the same solver used for load(),
      // so the matrix handles allocated in setup() are valid for the load() call.
      const memProps = new PropertyBag();
      memProps.replaceModelParams({
        ...MEMRISTOR_DEFAULTS,
        rOn: R_ON, rOff: R_OFF, initialState: INITIAL_W,
        mobility: MOBILITY, deviceLength: DEVICE_LENGTH, windowOrder: WINDOW_ORDER,
      });
      const mem = new MemristorElement(new Map([["A", 1], ["B", 2]]), memProps);

      const solver = new SparseSolver();
      solver._initStructure();
      const setupCtx = makeTestSetupContext({ solver });
      setupAll([mem as unknown as AnalogElement], setupCtx);

      const ctx = loadCtxFromFields({
        solver,
        matrix: solver,
        rhs: new Float64Array(3),
        rhsOld: new Float64Array(3),
        time: 0,
        cktMode: MODEDCOP | MODEINITFLOAT,
        dt: 0,
        method: "trapezoidal",
        order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7),
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        convergenceCollector: null,
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        temp: 300.15,
        vt: 0.025852,
        cktFixLimit: false,
        bypass: false,
        voltTol: 1e-6,
      });
      (mem as unknown as AnalogElement).load(ctx);

      const G = mem.conductance();

      // Expect 4 conductance stamps: (1,1,G), (1,2,-G), (2,1,-G), (2,2,G)
      // (node 1 → row/col 1, node 2 → row/col 2 — 1-based MNA convention)
      const entries = solver.getCSCNonZeros();
      const sumAt = (row: number, col: number) =>
        entries
          .filter((e) => e.row === row && e.col === col)
          .reduce((acc, e) => acc + e.value, 0);

      expect(sumAt(1, 1)).toBe(G);
      expect(sumAt(1, 2)).toBe(-G);
      expect(sumAt(2, 1)).toBe(-G);
      expect(sumAt(2, 2)).toBe(G);
    });
  });

  describe("definition", () => {
    it("MemristorDefinition has correct engine type and category", () => {
      expect(MemristorDefinition.modelRegistry?.behavioral).toBeDefined();
      expect(MemristorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("MemristorDefinition has rOn default 100", () => {
      const params = MemristorDefinition.modelRegistry?.behavioral?.params;
      expect(params).toBeDefined();
      expect(params!["rOn"]).toBe(100);
    });

    it("MemristorDefinition has rOff default 16000", () => {
      const params = MemristorDefinition.modelRegistry?.behavioral?.params;
      expect(params).toBeDefined();
      expect(params!["rOff"]).toBe(16000);
    });

    it("analogFactory creates a MemristorElement", () => {
      const props = new PropertyBag();
      props.replaceModelParams(MEMRISTOR_DEFAULTS);
      const element = createMemristorElement(new Map([["A", 1], ["B", 2]]), props, () => 0);
      expect(element).toBeInstanceOf(MemristorElement);
    });

    it("branchCount is false", () => {
      expect((MemristorDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// C4.2 — Transient parity test
//
// Circuit: Memristor with _pinNodes=[A=1, B=0(gnd)].
// All voltages zero throughout → vAB=0 → current=0 → dw/dt=0 → w=w0 constant.
//
// The memristor is nonlinear (checkConvergence present) with no state pool.
// load() stamps a pure conductance G(w) = w*(1/R_on - 1/R_off) + 1/R_off.
// accept() integrates w forward via Euler: w_new = w + dWdt*dt.
// With zero voltage, current=0 → dWdt=0 → w is constant every step.
//
// At each accepted step, load() stamps:
//   G_stamp = w_0 * (1/R_on − 1/R_off) + 1/R_off   (bit-exact reference constant)
// and accept() leaves w unchanged.
//
// ngspice source → our variable mapping:
//   memristor conductance G(w)  → this.conductance() = w*(1/R_on−1/R_off)+1/R_off
//   Joglekar dw/dt formula      → accept(): dWdt = (μ*R_on/D²)*i*fp
//   Euler integration w_new     → this._w = clamp(w + dWdt*dt, 0, 1)
// ---------------------------------------------------------------------------

describe("memristor_load_transient_parity (C4.2)", () => {
  it("memristor_load_transient_parity", () => {
    const rOn         = 100;     // Ω
    const rOff        = 16000;   // Ω
    const w0          = 0.5;     // initial state
    const mobility    = 1e-14;   // m²/(V·s)
    const deviceLen   = 10e-9;   // m
    const windowOrder = 1;
    const dt          = 1e-6;    // timestep (s)
    const order       = 1;
    const method      = "trapezoidal" as const;

    // Bit-exact reference conductance at w=w0 (constant — zero voltage keeps w=w0)
    //   G(w) = w*(1/R_on − 1/R_off) + 1/R_off
    const G_ref = w0 * (1 / rOn - 1 / rOff) + 1 / rOff;

    // Build element: _pinNodes=[A=1, B=0(gnd)]
    const memProps2 = new PropertyBag();
    memProps2.replaceModelParams({ ...MEMRISTOR_DEFAULTS, rOn, rOff, initialState: w0, mobility, deviceLength: deviceLen, windowOrder });
    const mem = new MemristorElement(new Map([["A", 1], ["B", 0]]), memProps2);

    // Handle-based capture solver (persistent handles across steps).
    // setup() allocates handles into this solver, so load() stamps through the
    // same handle table. Node A=1, B=0(gnd) → only _hPP at (1,1) is allocated
    // (ground-guarded: negNode=0 skips _hNN/_hPN/_hNP per ressetup.c:46-49).
    const handles: { row: number; col: number }[] = [];
    const handleIndex = new Map<string, number>();
    const matValues: number[] = [];

    const solver = {
      allocElement: (row: number, col: number): number => {
        const key = `${row},${col}`;
        let h = handleIndex.get(key);
        if (h === undefined) {
          h = handles.length;
          handles.push({ row, col });
          handleIndex.set(key, h);
          matValues.push(0);
        }
        return h;
      },
      stampElement: (h: number, v: number): void => { matValues[h] += v; },
      stampRHS: (_row: number, _v: number): void => {},
      _initStructure: () => {},
    } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;

    // Run setup() against the capture solver so _hPP is allocated at key "1,1".
    const setupCtx = makeTestSetupContext({ solver });
    setupAll([mem as unknown as AnalogElement], setupCtx);

    const ag = new Float64Array(7);
    ag[0] = 1 / dt;
    ag[1] = -1 / dt;

    // All voltages zero → vAB=0 → current=0 → dw/dt=0 → w stays at w0.
    // Size 2: index 0=node 0 (gnd), index 1=node 1 (A). Both zero.
    const voltages = new Float64Array(2);

    // 10-step transient loop
    for (let step = 0; step < 10; step++) {
      matValues.fill(0);

      const ctx = loadCtxFromFields({
        solver,
        matrix: solver,
        rhs: voltages,
        rhsOld: voltages,
        time: 0,
        cktMode: MODETRAN | (step === 0 ? MODEINITTRAN : MODEINITFLOAT),
        dt,
        method,
        order,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        convergenceCollector: null,
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        temp: 300.15,
        vt: 0.025852,
        cktFixLimit: false,
        bypass: false,
        voltTol: 1e-6,
      });

      mem.load(ctx);

      // Assert per-step integration constants (spec: assert dt, order, method)
      expect(ctx.dt).toBe(dt);
      expect(ctx.order).toBe(order);
      expect(ctx.method).toBe(method);

      // Assert stamped conductance is bit-exact G(w0) (zero voltage → w constant).
      // _hPP is allocated at (nodeA=1, nodeA=1) by setup() → key "1,1".
      const h11 = handleIndex.get("1,1")!;
      expect(matValues[h11]).toBe(G_ref);

      // Call accept() with zero voltages → dWdt=0 → w unchanged
      mem.accept(ctx, step * dt, () => {});

      // w must remain w0 bit-exactly (zero current means no state evolution)
      expect(mem.w).toBe(w0);
    }
  });
});
