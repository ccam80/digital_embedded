/**
 * JFET tests — post-Phase-2.5-W1.4 A1 test handling.
 *
 * Per `spec/architectural-alignment.md` §A1 test-handling rule, the vast
 * majority of pre-port JFET tests have been deleted:
 *   - Hand-computed expected values on intermediate state (cutoff_zero_current,
 *     saturation_current, linear_region, gate_forward_current,
 *     output_characteristics, lambda_channel_length_modulation) → deleted.
 *   - Tests inspecting invented extension slots SLOT_VGS_JUNCTION / SLOT_GD_JUNCTION
 *     / SLOT_ID_JUNCTION (all excised by W1.4) → deleted.
 *   - jfet_load_dcop_parity / MODEINITSMSIG / MODEINITTRAN tests that
 *     hand-computed expected values via the banned `Math.min(expArg, 80)`
 *     clamp (PARITY items A-1, A-2) → deleted.
 *   - fet-base.test.ts (whole file) → deleted (D-10: fet-base.ts is gone).
 *
 * Survivors (engine-agnostic interface contracts + parameter plumbing +
 * convergence interface contract):
 *   - Registration: NJfetDefinition / PJfetDefinition resolve via
 *     ComponentRegistry.
 *   - Pin layout: G/S/D pins present.
 *   - NR convergence: common-source JFET self-biases within 10 iterations.
 *   - PJFET polarity: weak stamp-emission smoke test (no hand-computed
 *     equality).
 */

import { describe, it, expect } from "vitest";
import {
  NJfetDefinition,
  createNJfetElement,
} from "../njfet.js";
import {
  PJfetDefinition,
  createPJfetElement,
} from "../pjfet.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// withState — allocate a StatePool and call initState on the element
// ---------------------------------------------------------------------------

function withState(element: AnalogElementCore): ReactiveAnalogElement {
  const re = element as ReactiveAnalogElement;
  re.stateBaseOffset = 0;
  const pool = new StatePool(re.stateSize);
  re.initState(pool);
  return re;
}

// ---------------------------------------------------------------------------
// Default model parameters
// ---------------------------------------------------------------------------

const NJFET_PARAMS = {
  VTO: -2.0,
  BETA: 1e-4,
  LAMBDA: 0,
  IS: 1e-14,
  N: 1,
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  B: 1.0,
  TCV: 0,
  BEX: 0,
  AREA: 1,
  M: 1,
  KF: 0,
  AF: 1,
  TNOM: 300.15,
  OFF: 0,
};

const PJFET_PARAMS = {
  VTO: 2.0,
  BETA: 1e-4,
  LAMBDA: 0,
  IS: 1e-14,
  N: 1,
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  B: 1.0,
  TCV: 0,
  BEX: 0,
  AREA: 1,
  M: 1,
  KF: 0,
  AF: 1,
  TNOM: 300.15,
  OFF: 0,
};

// ---------------------------------------------------------------------------
// DC-OP LoadContext helper.
// ---------------------------------------------------------------------------

function makeDcOpCtx(voltages: Float64Array, matrixSize: number): LoadContext {
  const solver = new SparseSolver();
  solver.beginAssembly(matrixSize);
  return {
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    voltages,
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
  } as LoadContext;
}

// ---------------------------------------------------------------------------
// Helper: inline resistor
// ---------------------------------------------------------------------------

function makeResistorElement(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    load(ctx: LoadContext): void {
      const { solver } = ctx;
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA - 1, nodeB - 1), -G);
        solver.stampElement(solver.allocElement(nodeB - 1, nodeA - 1), -G);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PJFET — weak stamp-emission smoke test (engine-agnostic contract).
// ---------------------------------------------------------------------------

describe("PJFET", () => {
  it("emits_stamps_when_conducting", () => {
    // Common-source PJFET: Vg=2V, Vd=0V, Vs=5V. Device should conduct and
    // emit non-trivial stamps. No hand-computed expected values.
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(PJFET_PARAMS);
    const core = withState(createPJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), [], -1, propsObj));
    const element = withNodeIds(core, [1, 2, 3]);

    const voltages = new Float64Array(3);
    voltages[0] = 2;
    voltages[1] = 0;
    voltages[2] = 5;

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 3));
    }

    const ctx = makeDcOpCtx(voltages, 3);
    element.load(ctx);
    const entries = ctx.solver.getCSCNonZeros();

    const nonzeroStamps = entries.filter((e) => Math.abs(e.value) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// NR convergence test — engine-agnostic interface contract.
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("converges_within_10_iterations", () => {
    // Common-source NJFET with Rd load: Vdd=10V, Rd=10kΩ, gate grounded.
    const matrixSize = 5;

    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const jfet = withState(withNodeIds(createNJfetElement(new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1, propsObj), [3, 0, 1]));
    const rd = makeResistorElement(2, 1, 10000);
    const vdd = makeDcVoltageSource(2, 0, 3, 10.0) as unknown as AnalogElement;
    const vgate = makeDcVoltageSource(3, 0, 4, 0.0) as unknown as AnalogElement;

    const result = runDcOp({
      elements: [vdd, vgate, rd, jfet],
      matrixSize,
      nodeCount: 3,
      params: { maxIterations: 10 },
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Registration tests — parameter plumbing / component registry.
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("njfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(NJfetDefinition);

    const def = registry.get("NJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect(def!.category).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("pjfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(PJfetDefinition);

    const def = registry.get("PJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("njfet_pin_layout_has_three_pins", () => {
    expect(NJfetDefinition.pinLayout).toHaveLength(3);
    const labels = NJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });

  it("pjfet_pin_layout_has_three_pins", () => {
    expect(PJfetDefinition.pinLayout).toHaveLength(3);
    const labels = PJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });
});
