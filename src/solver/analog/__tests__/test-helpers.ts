/**
 * Engine-internal test fixture elements for MNA infrastructure testing.
 *
 * These are minimal AnalogElement implementations used only in unit tests.
 * They are not ComponentDefinition registrations and do not appear in the
 * component palette. Phase 2 delivers the full registered component set.
 *
 * MNA stamp conventions (standard SPICE Modified Nodal Analysis):
 *
 *   Resistor (nodes A, B, conductance G = 1/R):
 *     G[A,A] += G    G[A,B] -= G
 *     G[B,A] -= G    G[B,B] += G
 *
 *   Voltage source (nodes pos, neg, branch row k, voltage V):
 *     B[pos,k] += 1   C[k,pos] += 1
 *     B[neg,k] -= 1   C[k,neg] -= 1
 *     RHS[k]   += V
 *
 *   Current source (nodes pos, neg, current I flowing from neg to pos):
 *     RHS[pos] += I
 *     RHS[neg] -= I
 *
 * Node 0 is ground; stamps into ground rows/cols are suppressed (ground is
 * not a free variable in the MNA system).
 */

import { SparseSolver } from "../sparse-solver.js";
import type { AnalogElement, AnalogElementCore, ReactiveAnalogElement } from "../element.js";
import { isPoolBacked } from "../element.js";
import type { LoadContext } from "../load-context.js";
import { pnjlim, newtonRaphson } from "../newton-raphson.js";
import { niIntegrate } from "../ni-integrate.js";
import { StatePool } from "../state-pool.js";
import type { StatePoolRef } from "../../../core/analog-types.js";
import { AnalogCapacitorElement } from "../../../components/passives/capacitor.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../state-schema.js";
import { CKTCircuitContext, type DcOpResult, type NRResult } from "../ckt-context.js";
import { solveDcOperatingPoint } from "../dc-operating-point.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { DEFAULT_SIMULATION_PARAMS, type ResolvedSimulationParams } from "../../../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// withNodeIds — test helper for factory-created elements
// ---------------------------------------------------------------------------

/**
 * Stamp pinNodeIds and allNodeIds onto an AnalogElementCore, promoting it
 * to a full AnalogElement. Used by tests that call component factories
 * directly (bypassing the compiler which normally sets these fields).
 *
 * @param core - Factory return value (AnalogElementCore)
 * @param pinNodeIds - Pin node IDs in pinLayout order
 * @param internalNodeIds - Optional internal node IDs (default: none)
 */
export function withNodeIds(
  core: AnalogElementCore,
  pinNodeIds: readonly number[],
  internalNodeIds: readonly number[] = [],
): AnalogElement {
  return Object.assign(core, {
    pinNodeIds,
    allNodeIds: [...pinNodeIds, ...internalNodeIds],
  }) as AnalogElement;
}

// ---------------------------------------------------------------------------
// Internal helper — stamp into solver, skipping ground (node 0)
// ---------------------------------------------------------------------------

function G(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    const h = solver.allocElement(row - 1, col - 1);
    solver.stampElement(h, val);
  }
}

/** Unguarded stamp at absolute solver-space (row, col). */
function S(solver: SparseSolver, row: number, col: number, val: number): void {
  const h = solver.allocElement(row, col);
  solver.stampElement(h, val);
}

function RHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
}

// ---------------------------------------------------------------------------
// makeResistor
// ---------------------------------------------------------------------------

/**
 * Create a linear resistor test element.
 *
 * Stamps a conductance G = 1/resistance into the G sub-matrix of the MNA
 * system. Both nodes are in the standard 1-based scheme (0 = ground).
 *
 * @param nodeA      - First terminal node ID (0 = ground)
 * @param nodeB      - Second terminal node ID (0 = ground)
 * @param resistance - Resistance in ohms (must be > 0)
 * @returns An AnalogElement that stamps resistor contributions
 */
export function makeResistor(
  nodeA: number,
  nodeB: number,
  resistance: number,
): AnalogElement {
  const G_val = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,

    load(ctx: LoadContext): void {
      const { solver } = ctx;
      G(solver, nodeA, nodeA, G_val);
      G(solver, nodeA, nodeB, -G_val);
      G(solver, nodeB, nodeA, -G_val);
      G(solver, nodeB, nodeB, G_val);
    },

    setParam(_key: string, _value: number): void {},

    getPinCurrents(voltages: Float64Array): number[] {
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const I = G_val * (vA - vB);
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// makeVoltageSource
// ---------------------------------------------------------------------------

/**
 * Create an ideal voltage source test element.
 *
 * Introduces one extra MNA branch row at `branchIdx` (0-based within the
 * branch block, i.e. actual matrix row = nodeCount + branchIdx).
 *
 * The caller is responsible for ensuring `beginAssembly` was called with
 * `matrixSize = nodeCount + branchCount` so the branch row exists.
 *
 * Stamp convention (1-based node IDs, solver uses 0-based indices):
 *   B[nodePos, k] += 1    C[k, nodePos] += 1
 *   B[nodeNeg, k] -= 1    C[k, nodeNeg] -= 1
 *   RHS[k]        += voltage
 *
 * where k = nodeCount + branchIdx (0-based in solver).
 *
 * @param nodePos   - Positive terminal node ID (0 = ground)
 * @param nodeNeg   - Negative terminal node ID (0 = ground)
 * @param branchIdx - 0-based branch index within the branch block; the
 *                    actual solver row is nodeCount + branchIdx
 * @param voltage   - Source voltage in volts
 * @returns An AnalogElement that stamps voltage source contributions
 */
export function makeVoltageSource(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  voltage: number,
): AnalogElement {
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},

    load(ctx: LoadContext): void {
      const { solver } = ctx;
      // The branch row is an absolute 0-based solver index supplied by the
      // caller via branchIdx. We do NOT offset by nodeCount here — the caller
      // sets up the matrix with matrixSize = nodeCount + branchCount and
      // passes branchIdx as the absolute row within that full matrix.
      const k = branchIdx; // absolute 0-based solver row

      // B sub-matrix (node rows, branch column k)
      if (nodePos !== 0) S(solver, nodePos - 1, k, 1);
      if (nodeNeg !== 0) S(solver, nodeNeg - 1, k, -1);

      // C sub-matrix (branch row k, node columns)
      if (nodePos !== 0) S(solver, k, nodePos - 1, 1);
      if (nodeNeg !== 0) S(solver, k, nodeNeg - 1, -1);

      // RHS entry for the voltage constraint (scaled by source stepping factor
      // via ctx.srcFact — ngspice CKTsrcFact).
      solver.stampRHS(k, voltage * ctx.srcFact);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const I = voltages[branchIdx];
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// makeCurrentSource
// ---------------------------------------------------------------------------

/**
 * Create an ideal independent current source test element.
 *
 * Current flows from nodeNeg to nodePos through the source (conventional
 * positive direction: into nodePos, out of nodeNeg).
 *
 * Stamps only into the RHS vector — no G-matrix entries.
 *
 * @param nodePos - Node where current enters (0 = ground)
 * @param nodeNeg - Node where current leaves (0 = ground)
 * @param current - Source current in amperes (positive = into nodePos)
 * @returns An AnalogElement that stamps current source contributions
 */
export function makeCurrentSource(
  nodePos: number,
  nodeNeg: number,
  current: number,
): AnalogElement {
  let lastSrcFact = 1;
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},

    load(ctx: LoadContext): void {
      const { solver } = ctx;
      lastSrcFact = ctx.srcFact;
      RHS(solver, nodePos, current * ctx.srcFact);
      RHS(solver, nodeNeg, -(current * ctx.srcFact));
    },

    getPinCurrents(): number[] {
      const I = current * lastSrcFact;
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// makeDiode
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance added for numerical stability (GMIN). */
const GMIN = 1e-12;

// State pool slot indices
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;

/** Schema for test helper diode (4 slots). */
const DIODE_SCHEMA: StateSchema = defineStateSchema("TestHelperDiodeElement", [
  { name: "VD",  doc: "Diode voltage (anode minus cathode)",            init: { kind: "zero" } },
  { name: "GEQ", doc: "Equivalent conductance (linearized)",             init: { kind: "constant", value: GMIN } },
  { name: "IEQ", doc: "Norton equivalent current source",               init: { kind: "zero" } },
  { name: "ID",  doc: "Diode current (anode to cathode)",               init: { kind: "zero" } },
]);

/**
 * Create a Shockley diode test element with NR linearization.
 *
 * Models the ideal diode equation: Id = Is · (exp(Vd / (n·Vt)) - 1)
 *
 * The companion model at each NR iteration linearizes the exponential as a
 * parallel conductance (geq) and independent current source (ieq):
 *   geq = dId/dVd = Is · exp(Vd/(n·Vt)) / (n·Vt)   + GMIN
 *   ieq = Id - geq · Vd                              (Norton equivalent offset)
 *
 * `stamp()` is a no-op — the diode has no linear (topology-independent)
 * contribution. All MNA entries come from `stampNonlinear`.
 *
 * State is stored in a StatePool. Use `withState` to allocate the pool.
 *
 * @param nodeAnode   - Anode node ID (0 = ground, 1-based)
 * @param nodeCathode - Cathode node ID (0 = ground, 1-based)
 * @param is          - Saturation current in amperes (e.g. 1e-14)
 * @param n           - Ideality factor (typically 1.0–2.0)
 * @returns An AnalogElement implementing the Shockley diode model
 */
export function makeDiode(
  nodeAnode: number,
  nodeCathode: number,
  is: number,
  n: number,
): ReactiveAnalogElement {
  const nVt = n * VT;
  const vcrit = nVt * Math.log(nVt / (is * Math.SQRT2));

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;

  return {
    pinNodeIds: [nodeAnode, nodeCathode],
    allNodeIds: [nodeAnode, nodeCathode],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,
    poolBacked: true as const,
    stateSize: 4,
    stateBaseOffset: -1,
    stateSchema: DIODE_SCHEMA,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
      base = this.stateBaseOffset;
      applyInitialValues(DIODE_SCHEMA, pool, base, {});
    },

    setParam(_key: string, _value: number): void {},

    load(ctx: LoadContext): void {
      const { solver, voltages, noncon } = ctx;

      // Update operating point: read voltages, limit, compute Shockley model.
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;
      const vdOld = s0[base + SLOT_VD];
      const limResult = pnjlim(vdRaw, vdOld, nVt, vcrit);
      const vdLimited = limResult.value;
      if (limResult.limited) noncon.value++;
      s0[base + SLOT_VD] = vdLimited;

      const expArg = vdLimited / nVt;
      const clampedArg = Math.min(expArg, 700);
      const expVal = Math.exp(clampedArg);
      const id = is * (expVal - 1);
      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = (is * expVal) / nVt + GMIN;
      s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;

      // Stamp companion model: conductance geq in parallel, Norton offset ieq.
      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      G(solver, nodeAnode, nodeAnode, geq);
      G(solver, nodeAnode, nodeCathode, -geq);
      G(solver, nodeCathode, nodeAnode, -geq);
      G(solver, nodeCathode, nodeCathode, geq);
      RHS(solver, nodeAnode, -ieq);
      RHS(solver, nodeCathode, ieq);
    },

    checkConvergence(ctx: LoadContext): boolean {
      const { voltages } = ctx;
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;
      const vdLim = s0[base + SLOT_VD];
      return Math.abs(vdLim - vdRaw) <= 2 * nVt;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      const I = geq * (va - vc) - ieq;
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// makeCapacitor
// ---------------------------------------------------------------------------

/**
 * Create a linear capacitor test element with companion model integration.
 *
 * The capacitor is modelled as a parallel conductance (geq) and independent
 * current source (ieq) — the standard Norton companion model. Coefficients
 * are recomputed each timestep by `stampCompanion`; `stamp` re-stamps the
 * same coefficients on every NR iteration within that timestep.
 *
 * Stamp convention (nodes A, B):
 *   G[A,A] += geq    G[A,B] -= geq
 *   G[B,A] -= geq    G[B,B] += geq
 *   RHS[A]  += ieq   (current source: ieq flows from B to A through element)
 *   RHS[B]  -= ieq
 *
 * @param nodeA       - First terminal node ID (0 = ground)
 * @param nodeB       - Second terminal node ID (0 = ground)
 * @param capacitance - Capacitance in farads (must be > 0)
 * @returns An AnalogElement implementing the capacitor companion model
 */
export function makeCapacitor(
  nodeA: number,
  nodeB: number,
  capacitance: number,
): AnalogElement {
  // Companion model state — updated each NR iteration inside load().
  let geq = 0;
  let ceq = 0;
  // Charge history: q0 = current step, q1 = previous step, q2 = two steps back, q3 = three steps back.
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  let q3 = 0;
  // Companion current history for TRAP order 2 recursion (niinteg.c:32).
  let ccapPrev = 0;
  let firstTranStep = true;

  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: true,
    setParam(_key: string, _value: number): void {},

    load(ctx: LoadContext): void {
      const { solver, voltages, initMode, isDcOp, isTransient, ag } = ctx;

      if (!isTransient && !isDcOp) return;

      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vcap = vA - vB;

      if (isTransient) {
        if (initMode === "initPred") {
          q0 = q1;
        } else {
          q0 = capacitance * vcap;
          if (initMode === "initTran") {
            q1 = q0;
            firstTranStep = false;
          }
        }

        // NIintegrate via shared helper (niinteg.c:17-80).
        const result = niIntegrate(
          ctx.method,
          ctx.order,
          capacitance,
          ag,
          q0, q1,
          [q2, q3, 0, 0, 0],
          ccapPrev,
        );
        geq = result.geq;
        ceq = result.ceq;

        if (!firstTranStep) {
          G(solver, nodeA, nodeA, geq);
          G(solver, nodeA, nodeB, -geq);
          G(solver, nodeB, nodeA, -geq);
          G(solver, nodeB, nodeB, geq);
          RHS(solver, nodeA, -ceq);
          RHS(solver, nodeB, ceq);
        }
      }
      // DC operating point: no matrix stamp (capacitor is open in DC).
    },

    accept(ctx: LoadContext): void {
      // Advance history: q2 becomes q3, q1 becomes q2, current q0 becomes q1.
      // Also roll ccap into ccapPrev so TRAP order 2 recursion (niinteg.c:32) works.
      const { voltages } = ctx;
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      q3 = q2;
      q2 = q1;
      q1 = capacitance * (vA - vB);
      ccapPrev = ceq + geq * (vA - vB); // ccap = ceq + ag[0]*q0 = ceq + geq*v
      firstTranStep = false;
    },

    getLteTimestep(): number { return Infinity; },

    getPinCurrents(voltages: Float64Array): number[] {
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const I = geq * (vA - vB) + ceq;
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// makeInductor
// ---------------------------------------------------------------------------

/**
 * Create a linear inductor test element with companion model integration.
 *
 * An inductor introduces an extra MNA branch row to track branch current.
 * The companion model replaces it with a conductance (geq) and current source
 * (ieq) in the branch equation.
 *
 * MNA stamp for an inductor with nodes A, B and branch row k:
 *   In DC (before first stampCompanion): stamp as short circuit (voltage source V=0).
 *   After stampCompanion: the branch equation becomes:
 *     geq * V_AB - I_k = -ieq
 *   which in matrix form:
 *     B[A,k] +=  1   B[B,k] -= 1   (incidence: current into A, out of B)
 *     C[k,A] -= geq  C[k,B] += geq (branch equation)
 *     RHS[k] += -ieq
 *
 * For the test element, the inductor uses the companion model approach where
 * the branch row represents the inductor current directly.
 *
 * @param nodeA      - First terminal node ID (0 = ground)
 * @param nodeB      - Second terminal node ID (0 = ground)
 * @param branchIdx  - 0-based absolute branch row index in the MNA matrix
 * @param inductance - Inductance in henries (must be > 0)
 * @returns An AnalogElement implementing the inductor companion model
 */
export function makeInductor(
  nodeA: number,
  nodeB: number,
  branchIdx: number,
  inductance: number,
): AnalogElement {
  // Companion model state. Before transient starts, geq=0 makes branch equation
  // V_A - V_B = 0 (short circuit) — correct DC operating point for inductor.
  let geq = 0;
  let ceq = 0;
  // Flux history: phi0 = current, phi1 = previous, phi2 = two steps back.
  let phi0 = 0;
  let phi1 = 0;
  let phi2 = 0;
  let companionActive = false;

  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: true,
    setParam(_key: string, _value: number): void {},

    load(ctx: LoadContext): void {
      const { solver, voltages, initMode, isDcOp, isTransient, ag } = ctx;
      const k = branchIdx;

      // Topology-constant branch incidence stamps (always).
      if (nodeA !== 0) S(solver, nodeA - 1, k, 1);
      if (nodeB !== 0) S(solver, nodeB - 1, k, -1);

      if (!isTransient && !isDcOp) return;

      if (isTransient) {
        const iNow = voltages[k];

        if (initMode === "initPred") {
          phi0 = phi1;
        } else {
          phi0 = inductance * iNow;
          if (initMode === "initTran") {
            phi1 = phi0;
            companionActive = true;
          }
        }

        if (companionActive) {
          // NIintegrate inline using ctx.ag[] (dual of capacitor pattern).
          const cflux = ag[0] * phi0 + ag[1] * phi1 + (ag.length > 2 ? ag[2] * phi2 : 0);
          geq = ag[0] * inductance;
          ceq = cflux - ag[0] * phi0;

          // Branch equation: V_A - V_B - geq * I_k = ceq
          if (nodeA !== 0) S(solver, k, nodeA - 1, 1);
          if (nodeB !== 0) S(solver, k, nodeB - 1, -1);
          S(solver, k, k, -geq);
          solver.stampRHS(k, ceq);
        } else {
          // DC short-circuit model: V_A - V_B = 0
          if (nodeA !== 0) S(solver, k, nodeA - 1, 1);
          if (nodeB !== 0) S(solver, k, nodeB - 1, -1);
        }
      } else {
        // DC: short circuit
        if (nodeA !== 0) S(solver, k, nodeA - 1, 1);
        if (nodeB !== 0) S(solver, k, nodeB - 1, -1);
      }
    },

    accept(ctx: LoadContext): void {
      const { voltages } = ctx;
      const iNow = voltages[branchIdx];
      phi2 = phi1;
      phi1 = inductance * iNow;
      companionActive = true;
    },

    getLteTimestep(): number { return Infinity; },

    getPinCurrents(voltages: Float64Array): number[] {
      const I = voltages[branchIdx];
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// createTestCapacitor / createTestInductor — real element wrappers
// ---------------------------------------------------------------------------

/**
 * Create a real AnalogCapacitorElement for use in tests.
 * Parameter order differs from makeCapacitor: capacitance first, then nodes.
 */
export function createTestCapacitor(capacitance: number, nodeA: number, nodeB: number): AnalogElement {
  const el = new AnalogCapacitorElement(capacitance, NaN, 0, 0, 300.15, 1, 1);
  return withNodeIds(el, [nodeA, nodeB]);
}

/**
 * Create a real AnalogInductorElement for use in tests.
 * Parameter order differs from makeInductor: inductance first, then nodes, then branch.
 */
export function createTestInductor(inductance: number, nodeA: number, nodeB: number, branchIdx: number): AnalogElement {
  const el = new AnalogInductorElement(branchIdx, inductance, NaN, 0, 0, 300.15, 1, 1);
  return withNodeIds(el, [nodeA, nodeB]);
}

// ---------------------------------------------------------------------------
// makeAcVoltageSource
// ---------------------------------------------------------------------------

/**
 * Create a time-varying sinusoidal voltage source test element.
 *
 * Identical to `makeVoltageSource` except the RHS voltage is
 *   V(t) = dcOffset + amplitude · sin(2π · frequency · t + phase)
 *
 * The caller supplies a `getTime` callback that returns the current
 * simulation time in seconds. For MNAEngine integration, pass
 * `() => timeRef.value` where `timeRef` is shared with the compiled circuit.
 *
 * @param nodePos   - Positive terminal node ID (0 = ground)
 * @param nodeNeg   - Negative terminal node ID (0 = ground)
 * @param branchIdx - 0-based absolute branch row index in the MNA matrix
 * @param amplitude - Peak amplitude in volts
 * @param frequency - Frequency in Hz
 * @param phase     - Phase offset in radians (default 0)
 * @param dcOffset  - DC offset in volts (default 0)
 * @param getTime   - Callback returning current simulation time in seconds
 * @returns An AnalogElement that stamps AC voltage source contributions
 */
export function makeAcVoltageSource(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  amplitude: number,
  frequency: number,
  phase: number,
  dcOffset: number,
  getTime: () => number,
): AnalogElement {
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},

    load(ctx: LoadContext): void {
      const { solver } = ctx;
      const k = branchIdx;
      const t = getTime();
      const v =
        (dcOffset + amplitude * Math.sin(2 * Math.PI * frequency * t + phase)) *
        ctx.srcFact;

      // B sub-matrix (node rows, branch column k)
      if (nodePos !== 0) S(solver, nodePos - 1, k, 1);
      if (nodeNeg !== 0) S(solver, nodeNeg - 1, k, -1);

      // C sub-matrix (branch row k, node columns)
      if (nodePos !== 0) S(solver, k, nodePos - 1, 1);
      if (nodeNeg !== 0) S(solver, k, nodeNeg - 1, -1);

      // RHS voltage constraint
      solver.stampRHS(k, v);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const I = voltages[branchIdx];
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// allocateStatePool — mirror compiler state-pool allocation in test fixtures
// ---------------------------------------------------------------------------

/**
 * Assign `stateBaseOffset` sequentially to every element with `stateSize > 0`,
 * construct a `StatePool` sized to the total slot count, and invoke each
 * element's `initState` hook so closure-captured `s0`/`base` are populated.
 *
 * Tests that build `ConcreteCompiledAnalogCircuit` directly (bypassing the
 * real compiler) must call this before `engine.init()` — otherwise pool-backed
 * elements arrive with `stateBaseOffset=-1` and the engine's allocation
 * assertion throws. Tests that stamp into a solver without going through the
 * engine must also call this so element closures have a valid pool reference
 * to read/write.
 *
 * Mirrors the allocation loop in `src/compile/compiler.ts` that the real
 * compiler runs when building a production `CompiledAnalogCircuit`.
 */
export function allocateStatePool(
  elements: readonly (AnalogElement | AnalogElementCore)[],
): StatePool {
  let offset = 0;
  for (const el of elements) {
    if (isPoolBacked(el)) {
      el.stateBaseOffset = offset;
      offset += el.stateSize;
    }
  }
  const pool = new StatePool(offset);
  for (const el of elements) {
    if (isPoolBacked(el)) {
      (el as ReactiveAnalogElement).initState(pool);
    }
  }
  return pool;
}

// ---------------------------------------------------------------------------
// makeSimpleCtx / runDcOp / runNR — minimal ctx wrappers for component tests
// ---------------------------------------------------------------------------

export interface SimpleCtxOptions {
  solver?: SparseSolver;
  elements: readonly AnalogElement[];
  matrixSize: number;
  nodeCount: number;
  branchCount?: number;
  params?: Partial<ResolvedSimulationParams>;
  diagnostics?: DiagnosticCollector;
  statePool?: StatePool;
}

export function makeSimpleCtx(opts: SimpleCtxOptions): CKTCircuitContext {
  const branchCount = opts.branchCount ?? opts.matrixSize - opts.nodeCount;
  const statePool = opts.statePool ?? allocateStatePool(opts.elements);
  const params: ResolvedSimulationParams = { ...DEFAULT_SIMULATION_PARAMS, ...opts.params };
  const diagnostics = opts.diagnostics ?? new DiagnosticCollector();
  const solver = opts.solver ?? new SparseSolver();
  const ctx = new CKTCircuitContext(
    {
      nodeCount: opts.nodeCount,
      branchCount,
      matrixSize: opts.matrixSize,
      elements: opts.elements,
      statePool,
    },
    params,
    () => {},
    solver,
  );
  ctx.diagnostics = diagnostics;
  // Production drives loads through cktLoad(), which calls beginAssembly().
  // Tests that call element.load(ctx.loadCtx) directly skip that driver and
  // hit an uninitialized SparseSolver, silently corrupting its linked list.
  // Prime any real SparseSolver here so callers get a ready-to-use ctx;
  // stub/capture solvers (without beginAssembly) are left alone.
  if (solver instanceof SparseSolver) {
    solver.beginAssembly(opts.matrixSize);
  }
  return ctx;
}

export function runDcOp(opts: SimpleCtxOptions): DcOpResult {
  const ctx = makeSimpleCtx(opts);
  solveDcOperatingPoint(ctx);
  return ctx.dcopResult;
}

export interface SimpleNROptions {
  solver?: SparseSolver;
  elements: readonly AnalogElement[];
  matrixSize: number;
  nodeCount: number;
  branchCount?: number;
  params?: Partial<ResolvedSimulationParams>;
  diagnostics?: DiagnosticCollector;
  statePool?: StatePool;
  maxIterations?: number;
}

export function runNR(opts: SimpleNROptions): NRResult {
  const branchCount = opts.branchCount ?? opts.matrixSize - opts.nodeCount;
  const statePool = opts.statePool ?? allocateStatePool(opts.elements);
  const params: ResolvedSimulationParams = { ...DEFAULT_SIMULATION_PARAMS, ...opts.params };
  const diagnostics = opts.diagnostics ?? new DiagnosticCollector();
  const solver = opts.solver ?? new SparseSolver();
  const ctx = new CKTCircuitContext(
    {
      nodeCount: opts.nodeCount,
      branchCount,
      matrixSize: opts.matrixSize,
      elements: opts.elements,
      statePool,
    },
    params,
    () => {},
    solver,
  );
  ctx.diagnostics = diagnostics;
  if (opts.maxIterations !== undefined) {
    ctx.maxIterations = opts.maxIterations;
  }
  newtonRaphson(ctx);
  return ctx.nrResult;
}
