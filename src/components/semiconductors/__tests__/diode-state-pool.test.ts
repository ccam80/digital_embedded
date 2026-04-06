/**
 * Verification tests for the diode state pool migration.
 *
 * Asserts:
 *   - updateOperatingPoint does NOT modify the voltages array
 *   - pool.state0[base + SLOT_VD] contains the limited voltage after the call
 */

import { describe, it, expect } from "vitest";
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from "../diode.js";
import { PropertyBag } from "../../../core/properties.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";

const SLOT_VD = 0;
const SLOT_GEQ = 1;
const SLOT_IEQ = 2;
const SLOT_ID = 3;

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, ...params });
  return bag;
}

/**
 * Create a diode element with state pool initialized.
 * Returns the element and pool so tests can inspect state0.
 */
function makeDiodeWithPool(params: Record<string, number> = {}) {
  const props = makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, ...params });
  const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
  const stateSize = element.stateSize;
  const pool = new StatePool(stateSize);
  element.stateBaseOffset = 0;
  element.initState(pool);
  return { element, pool };
}

describe("diode state pool migration", () => {
  it("updateOperatingPoint does not modify the voltages array", () => {
    const { element } = makeDiodeWithPool();

    const voltages = new Float64Array([0.7, 0.0]);
    const snapshot = new Float64Array(voltages);

    element.updateOperatingPoint!(voltages);

    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
  });

  it("voltages array unchanged after large forward step that pnjlim would limit", () => {
    const { element } = makeDiodeWithPool();

    // Converge to 0.3V operating point first
    const voltages = new Float64Array([0.3, 0.0]);
    for (let i = 0; i < 20; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 0.3;
      voltages[1] = 0.0;
    }

    // Now apply a large step that pnjlim will compress
    voltages[0] = 5.0;
    voltages[1] = 0.0;
    element.updateOperatingPoint!(voltages);

    // Voltages must be unchanged
    expect(voltages[0]).toBe(5.0);
    expect(voltages[1]).toBe(0.0);
  });

  it("pool state0[SLOT_VD] contains limited voltage after updateOperatingPoint", () => {
    const { element, pool } = makeDiodeWithPool();

    const voltages = new Float64Array([0.7, 0.0]);
    element.updateOperatingPoint!(voltages);

    // SLOT_VD = 0: should hold the pnjlim-limited junction voltage
    const vdInPool = pool.state0[SLOT_VD];
    // At 0.7V initial call (vold=0), pnjlim may limit; the value must be finite and < 0.7 or =0.7
    expect(Number.isFinite(vdInPool)).toBe(true);
    expect(vdInPool).toBeLessThanOrEqual(0.7 + 1e-9);
  });

  it("pool state0[SLOT_VD] converges to target voltage after repeated calls", () => {
    const { element, pool } = makeDiodeWithPool();

    const voltages = new Float64Array([0.65, 0.0]);
    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 0.65;
      voltages[1] = 0.0;
    }

    // After convergence, SLOT_VD should equal 0.65V (pnjlim no longer limiting)
    expect(pool.state0[SLOT_VD]).toBeCloseTo(0.65, 10);
  });

  it("pool state0[SLOT_VD] holds limited voltage when pnjlim compresses large step", () => {
    const { element, pool } = makeDiodeWithPool();

    // Converge to 0.3V
    const voltages = new Float64Array([0.3, 0.0]);
    for (let i = 0; i < 20; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 0.3;
    }

    // Large step to 5V — pnjlim compresses
    voltages[0] = 5.0;
    voltages[1] = 0.0;
    element.updateOperatingPoint!(voltages);

    const limitedVd = pool.state0[SLOT_VD];
    // Must be less than 5V (pnjlim compressed) and positive (forward bias)
    expect(limitedVd).toBeLessThan(5.0);
    expect(limitedVd).toBeGreaterThan(0.0);
  });

  it("pool state0[SLOT_GEQ] is positive after forward bias update", () => {
    const { element, pool } = makeDiodeWithPool();

    const voltages = new Float64Array([0.7, 0.0]);
    element.updateOperatingPoint!(voltages);

    expect(pool.state0[SLOT_GEQ]).toBeGreaterThan(0);
  });

  it("pool state0[SLOT_ID] matches Shockley equation at converged operating point", () => {
    const IS = 1e-14;
    const N = 1;
    const VT = 0.02585;
    const { element, pool } = makeDiodeWithPool({ IS, N });

    // Converge to 0.65V
    const voltages = new Float64Array([0.65, 0.0]);
    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 0.65;
    }

    const vd = pool.state0[SLOT_VD];
    const expectedId = IS * (Math.exp(vd / (N * VT)) - 1);
    expect(pool.state0[SLOT_ID]).toBeCloseTo(expectedId, 6);
  });

  it("stateSize is 4 when CJO=0 and TT=0", () => {
    const props = makeParamBag({ CJO: 0, TT: 0 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    expect(element.stateSize).toBe(4);
  });

  it("stateSize is 8 when CJO > 0", () => {
    const props = makeParamBag({ CJO: 10e-12, TT: 0 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    expect(element.stateSize).toBe(8);
  });

  it("stateSize is 8 when TT > 0", () => {
    const props = makeParamBag({ CJO: 0, TT: 1e-9 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    expect(element.stateSize).toBe(8);
  });

  it("initState sets SLOT_GEQ to GMIN", () => {
    const GMIN = 1e-12;
    const { pool } = makeDiodeWithPool();
    expect(pool.state0[SLOT_GEQ]).toBe(GMIN);
  });

  it("voltages array unchanged for reverse bias update", () => {
    const { element } = makeDiodeWithPool();

    const voltages = new Float64Array([-5.0, 0.0]);
    const snapshot = new Float64Array(voltages);

    element.updateOperatingPoint!(voltages);

    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
  });

  it("capacitance slots initialized to zero before stampCompanion", () => {
    const props = makeParamBag({ CJO: 10e-12, TT: 0 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    const pool = new StatePool(element.stateSize);
    element.stateBaseOffset = 0;
    element.initState(pool);

    // SLOT_CAP_GEQ=4, SLOT_CAP_IEQ=5, SLOT_VD_PREV=6 start at zero
    expect(pool.state0[4]).toBe(0);
    expect(pool.state0[5]).toBe(0);
    expect(pool.state0[6]).toBe(0);
  });

  it("SLOT_CAP_FIRST_CALL is 1.0 after initState for capacitive diode", () => {
    const props = makeParamBag({ CJO: 10e-12, TT: 0 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    const pool = new StatePool(element.stateSize);
    element.stateBaseOffset = 0;
    element.initState(pool);

    // SLOT_CAP_FIRST_CALL=7 must be 1.0 so the first stampCompanion uses vNow as vPrev
    expect(pool.state0[7]).toBe(1.0);
  });

  it("SLOT_CAP_FIRST_CALL becomes 0 after first stampCompanion call", () => {
    const props = makeParamBag({ CJO: 10e-12, TT: 0 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    const pool = new StatePool(element.stateSize);
    element.stateBaseOffset = 0;
    element.initState(pool);

    const voltages = new Float64Array([-1.0, 0.0]);
    element.updateOperatingPoint!(voltages);
    element.stampCompanion!(1e-6, "trapezoidal", voltages);

    // After first stampCompanion, SLOT_CAP_FIRST_CALL must be cleared to 0
    expect(pool.state0[7]).toBe(0);
  });

  it("stateSchema is DIODE_SCHEMA for resistive diode", () => {
    const props = makeParamBag({ CJO: 0, TT: 0 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    expect(element.stateSchema).toBeDefined();
    expect(element.stateSchema.size).toBe(4);
    expect(element.stateSchema.owner).toBe("DiodeElement");
  });

  it("stateSchema is DIODE_CAP_SCHEMA for capacitive diode", () => {
    const props = makeParamBag({ CJO: 10e-12, TT: 0 });
    const element = createDiodeElement(new Map([["A", 1], ["K", 2]]), [], -1, props) as ReactiveAnalogElement;
    expect(element.stateSchema).toBeDefined();
    expect(element.stateSchema.size).toBe(8);
    expect(element.stateSchema.owner).toBe("DiodeElement_cap");
  });

  it("pool IEQ satisfies ieq = id - geq * vd at converged point", () => {
    const IS = 1e-14;
    const N = 1;
    const { element, pool } = makeDiodeWithPool({ IS, N });

    const voltages = new Float64Array([0.65, 0.0]);
    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 0.65;
    }

    const vd = pool.state0[SLOT_VD];
    const geq = pool.state0[SLOT_GEQ];
    const ieq = pool.state0[SLOT_IEQ];
    const id = pool.state0[SLOT_ID];

    const expectedIeq = id - geq * vd;
    expect(ieq).toBeCloseTo(expectedIeq, 10);
  });
});
