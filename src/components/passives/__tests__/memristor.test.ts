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
import type { LoadContext } from "../../../solver/analog/load-context.js";

// ---------------------------------------------------------------------------
// Test defaults matching MemristorDefinition
// ---------------------------------------------------------------------------

const R_ON = 100;
const R_OFF = 16000;
const INITIAL_W = 0.5;
const MOBILITY = 1e-14;
const DEVICE_LENGTH = 10e-9;
const WINDOW_ORDER = 1;

function makeMemristor(overrides: Partial<{
  rOn: number;
  rOff: number;
  initialState: number;
  mobility: number;
  deviceLength: number;
  windowOrder: number;
}> = {}): MemristorElement {
  const el = new MemristorElement(
    overrides.rOn ?? R_ON,
    overrides.rOff ?? R_OFF,
    overrides.initialState ?? INITIAL_W,
    overrides.mobility ?? MOBILITY,
    overrides.deviceLength ?? DEVICE_LENGTH,
    overrides.windowOrder ?? WINDOW_ORDER,
  );
  Object.assign(el, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
  return el;
}

/**
 * Integrate the memristor state variable w forward by one accepted step.
 * Memristor.accept() reads ctx.dt and ctx.voltages to compute dw/dt.
 */
function acceptStep(mem: MemristorElement, dt: number, voltages: Float64Array): void {
  const ctx: LoadContext = {
    solver: new SparseSolver(),
    voltages,
    iteration: 0,
    initMode: "transient",
    dt,
    method: "trapezoidal",
    order: 1,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag: new Float64Array(8),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: false,
    isTransient: true,
<<<<<<< HEAD

    isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
    isAc: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
  mem.accept(ctx, 0, () => {});
}

// ---------------------------------------------------------------------------
// Memristor
// ---------------------------------------------------------------------------

describe("Memristor", () => {
  describe("initial_resistance", () => {
    it("w=0.5 gives R = (R_on + R_off) / 2", () => {
      const mem = makeMemristor();
      const expected = (R_ON + R_OFF) / 2;
      expect(mem.resistance()).toBeCloseTo(expected, 2);
    });

    it("w=0.5 gives R = 8050 Ω with defaults", () => {
      const mem = makeMemristor();
      // R(0.5) = 100*0.5 + 16000*(0.5) = 50 + 8000 = 8050
      expect(mem.resistance()).toBeCloseTo(8050, 1);
    });

    it("conductance at w=0 equals 1/R_off", () => {
      const mem = makeMemristor({ initialState: 0.0 });
      // G(0) = 0*(1/R_on - 1/R_off) + 1/R_off = 1/R_off
      expect(mem.conductance()).toBeCloseTo(1 / R_OFF, 15);
    });

    it("conductance at w=1 equals 1/R_on", () => {
      const mem = makeMemristor({ initialState: 1.0 });
      // G(1) = 1*(1/R_on - 1/R_off) + 1/R_off = 1/R_on
      expect(mem.conductance()).toBeCloseTo(1 / R_ON, 15);
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
      expect(mem.w).toBeCloseTo(0.0, 5);
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

      expect(mem.w).toBeCloseTo(1.0, 5);
    });
  });

  describe("load", () => {
    it("stamps conductance between nodes A and B", () => {
      const mem = makeMemristor();

      const solver = new SparseSolver();
      solver.beginAssembly(2);
      const ctx: LoadContext = {
        solver,
        voltages: new Float64Array(2),
        iteration: 0,
        initMode: "initFloat",
        dt: 0,
        method: "trapezoidal",
        order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(8),
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        isDcOp: true,
        isTransient: false,
<<<<<<< HEAD

        isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
        isAc: false,
        xfact: 1,
        gmin: 1e-12,
        uic: false,
        reltol: 1e-3,
        iabstol: 1e-12,
      };
      (mem as unknown as AnalogElement).load(ctx);

      const G = mem.conductance();

      // Expect 4 conductance stamps: (0,0,G), (0,1,-G), (1,0,-G), (1,1,G)
      // (node 1 → index 0, node 2 → index 1)
      const entries = solver.getCSCNonZeros();
      const sumAt = (row: number, col: number) =>
        entries
          .filter((e) => e.row === row && e.col === col)
          .reduce((acc, e) => acc + e.value, 0);

      expect(sumAt(0, 0)).toBe(G);
      expect(sumAt(0, 1)).toBe(-G);
      expect(sumAt(1, 0)).toBe(-G);
      expect(sumAt(1, 1)).toBe(G);
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
      const element = createMemristorElement(new Map([["A", 1], ["B", 2]]), [], -1, props);
      expect(element).toBeInstanceOf(MemristorElement);
      expect(element.isNonlinear).toBe(true);
      expect(element.isReactive).toBe(false);
    });

    it("branchCount is false", () => {
      expect((MemristorDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// C4.2 — Transient parity test
//
// Circuit: Memristor with pinNodeIds=[A=1, B=0(gnd)].
// All voltages zero throughout → vAB=0 → current=0 → dw/dt=0 → w=w0 constant.
//
// The memristor is nonlinear but NOT reactive (isReactive=false, no state pool).
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

    // Build element: pinNodeIds=[A=1, B=0(gnd)]
    const mem = new MemristorElement(rOn, rOff, w0, mobility, deviceLen, windowOrder);
    Object.assign(mem, { pinNodeIds: [1, 0], allNodeIds: [1, 0] });

    // Handle-based capture solver (persistent handles across steps)
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
    } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;

    const ag = new Float64Array(8);
    ag[0] = 1 / dt;
    ag[1] = -1 / dt;

    // All voltages zero → vAB=0 → current=0 → dw/dt=0 → w stays at w0.
    const voltages = new Float64Array(2);

    // 10-step transient loop
    for (let step = 0; step < 10; step++) {
      matValues.fill(0);

      const ctx: LoadContext = {
        solver,
        voltages,
        iteration: 0,
        initMode: step === 0 ? "initTran" : "transient",
        dt,
        method,
        order,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector: null,
        isDcOp: false,
        isTransient: true,
<<<<<<< HEAD

        isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
        isAc: false,
        xfact: 1,
        gmin: 1e-12,
        uic: false,
        reltol: 1e-3,
        iabstol: 1e-12,
      };

      mem.load(ctx);

      // Assert per-step integration constants (spec: assert dt, order, method)
      expect(ctx.dt).toBe(dt);
      expect(ctx.order).toBe(order);
      expect(ctx.method).toBe(method);

      // Assert stamped conductance is bit-exact G(w0) (zero voltage → w constant)
      // stampG stamps G on [nA-1,nA-1] — matValues[0] after fill(0) is G_ref.
      const h00 = handleIndex.get("0,0")!;
      expect(matValues[h00]).toBe(G_ref);

      // Call accept() with zero voltages → dWdt=0 → w unchanged
      mem.accept(ctx, step * dt, () => {});

      // w must remain w0 bit-exactly (zero current means no state evolution)
      expect(mem.w).toBe(w0);
    }
  });
});
