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

import type { SparseSolver } from "../sparse-solver.js";
import type { AnalogElement, AnalogElementCore, ReactiveAnalogElement, IntegrationMethod } from "../element.js";
import { isPoolBacked } from "../element.js";
import { pnjlim } from "../newton-raphson.js";
import { StatePool } from "../state-pool.js";
import type { StatePoolRef } from "../../../core/analog-types.js";
import { AnalogCapacitorElement } from "../../../components/passives/capacitor.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import {
  integrateCapacitor,
  integrateInductor,
} from "../integration.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../state-schema.js";

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
    solver.stamp(row - 1, col - 1, val);
  }
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
    stamp(solver: SparseSolver): void {
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
  let scale = 1;
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    setSourceScale(factor: number): void {
      scale = factor;
    },
    setParam(_key: string, _value: number): void {},
    stamp(solver: SparseSolver): void {
      // The branch row is an absolute 0-based solver index supplied by the
      // caller via branchIdx. We do NOT offset by nodeCount here — the caller
      // sets up the matrix with matrixSize = nodeCount + branchCount and
      // passes branchIdx as the absolute row within that full matrix.
      const k = branchIdx; // absolute 0-based solver row

      // B sub-matrix (node rows, branch column k)
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, k, -1);

      // C sub-matrix (branch row k, node columns)
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeNeg !== 0) solver.stamp(k, nodeNeg - 1, -1);

      // RHS entry for the voltage constraint (scaled by source stepping factor)
      solver.stampRHS(k, voltage * scale);
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
  let scale = 1;
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setSourceScale(factor: number): void {
      scale = factor;
    },
    setParam(_key: string, _value: number): void {},
    stamp(solver: SparseSolver): void {
      RHS(solver, nodePos, current * scale);
      RHS(solver, nodeNeg, -(current * scale));
    },

    getPinCurrents(): number[] {
      const I = current * scale;
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

    stamp(_solver: SparseSolver): void {
      // No linear (topology-constant) contributions for a diode.
    },

    stampNonlinear(solver: SparseSolver): void {
      // Stamp companion model: conductance geq in parallel, Norton offset ieq
      // Current flows from anode to cathode when vd > 0.
      // G sub-matrix (conductance between anode and cathode):
      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      G(solver, nodeAnode, nodeAnode, geq);
      G(solver, nodeAnode, nodeCathode, -geq);
      G(solver, nodeCathode, nodeAnode, -geq);
      G(solver, nodeCathode, nodeCathode, geq);
      // RHS: Norton current source (ieq flows from cathode to anode through element)
      RHS(solver, nodeAnode, -ieq);
      RHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>): void {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // Read vold from pool
      const vdOld = s0[base + SLOT_VD];

      // Apply pnjlim to prevent exponential runaway
      const vdLimited = pnjlim(vdRaw, vdOld, nVt, vcrit).value;

      s0[base + SLOT_VD] = vdLimited;

      // Shockley equation and NR linearization at limited operating point
      const expArg = vdLimited / nVt;
      // Clamp exponent to avoid Float64 overflow (exp(>709) = Infinity)
      const clampedArg = Math.min(expArg, 700);
      const expVal = Math.exp(clampedArg);
      const id = is * (expVal - 1);
      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = (is * expVal) / nVt + GMIN;
      s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, _reltol: number, _abstol: number): boolean {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;
      const vdLim = s0[base + SLOT_VD];
      // Converged when the limited voltage and raw solver voltage agree within tolerance.
      // This matches SPICE's junction convergence criterion.
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
  let geq = 0;
  let ieq = 0;
  // History for BDF-2: track previous terminal voltages v(n-1) and v(n-2).
  let vPrev = 0;
  let vPrev2 = 0;
  let ccapPrevCap = 0;
  // Saved ccap from before stampCompanion ran, so updateChargeFlux can use the
  // correct ccap_{n-1} seed (stampCompanion overwrites ccapPrevCap with ccap_n).
  let ccapBeforeStamp = 0;
  let firstCall = true;

  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: true,
    setParam(_key: string, _value: number): void {},

    stamp(solver: SparseSolver): void {
      // Stamp Norton companion model: conductance geq + history current source ieq.
      //
      // KCL at nodeA: current leaving via cap = geq*(vA-vB) + ieq
      // MNA equation: (G_R + geq)*vA = -ieq  (history current enters RHS negated)
      G(solver, nodeA, nodeA, geq);
      G(solver, nodeA, nodeB, -geq);
      G(solver, nodeB, nodeA, -geq);
      G(solver, nodeB, nodeB, geq);
      RHS(solver, nodeA, -ieq);
      RHS(solver, nodeB, ieq);
    },

    stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array, order = 1, deltaOld: readonly number[] = []): void {
      // Save ccap_{n-1} before overwriting it, so updateChargeFlux can use the
      // correct seed for the trapezoidal recursion at the converged voltage.
      ccapBeforeStamp = ccapPrevCap;

      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vNow = vA - vB;

      // q0 = charge at the current accepted voltage (the operating point for the
      // new step). q1 = charge at the PREVIOUS accepted voltage (from vPrev).
      // On the first call, vPrev has not been set yet, so q1 = q0 (DC IC).
      //
      // IMPORTANT: vNow here is the ACCEPTED voltage from the previous solve.
      // vPrev is the ACCEPTED voltage from two solves ago.
      // The companion model for the upcoming step uses:
      //   ceq = ccap - geq * vNow  where ccap = (q0 - q1) / dt for BDF-1
      //       = (C*vNow - C*vPrev)/dt - C/dt * vNow = -C*vPrev/dt
      // So we need q1 = C * (PREVIOUS ACCEPTED VOLTAGE).
      // vPrev is saved as the vNow from the PREVIOUS stampCompanion call,
      // which IS the previous accepted voltage. ✓
      // vNow is the most recently accepted voltage (post-solve from the previous step).
      // For BDF-1: companion is geq = C/dt, ceq = -C*vNow/dt.
      // We pass q0 = q1 = C*vNow so that ccap = 0 and ceq = 0 - geq*vNow = -C*vNow/dt.
      // For BDF-2 (order=2): q1 = C*vPrev (voltage from 2 steps back), q2 = C*vPrev2.
      const q0 = capacitance * vNow;
      const q1 = order <= 1 ? q0 : capacitance * (firstCall ? vNow : vPrev);
      const q2 = order <= 1 ? q0 : capacitance * (firstCall ? vNow : vPrev2);
      const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
      const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
      const result = integrateCapacitor(capacitance, vNow, q0, q1, q2, dt, h1, h2, order, method, firstCall ? 0 : ccapPrevCap);
      geq = result.geq;
      ieq = result.ceq;
      ccapPrevCap = result.ccap;

      // Save history for BDF-2.
      vPrev2 = firstCall ? vNow : vPrev;
      vPrev = vNow;
      firstCall = false;
    },

    updateChargeFlux(voltages: Float64Array, dt: number, method: IntegrationMethod, order: number, deltaOld: readonly number[]): void {
      // Write ONLY the _NOW slot — never shift history (per interface contract).
      // Recompute ccap from converged voltage so the next step's trapezoidal
      // recursion starts from the correct companion current.
      // Use ccapBeforeStamp (ccap_{n-1}) as the seed — ccapPrevCap was already
      // overwritten by stampCompanion with the initial-guess ccap_n.
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vNow = vA - vB;
      const q0 = capacitance * vNow;
      const q1 = capacitance * vPrev;
      const q2 = capacitance * vPrev2;
      if (dt > 0) {
        const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
        const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
        const result = integrateCapacitor(capacitance, vNow, q0, q1, q2, dt, h1, h2, order, method, ccapBeforeStamp);
        ccapPrevCap = result.ccap;
      }
      // Do NOT shift vPrev/vPrev2 — stampCompanion owns history advancement.
    },

    getLteTimestep(): number { return Infinity; },

    getPinCurrents(voltages: Float64Array): number[] {
      const vA = nodeA > 0 ? voltages[nodeA - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const I = geq * (vA - vB) + ieq;
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
  // Companion model state. Before the first stampCompanion call these are zero,
  // which makes the branch equation V_A - V_B = 0 (short circuit) — the correct
  // DC operating point for an inductor.
  let geq = 0;
  let ieq = 0;
  // History for BDF-2: track previous flux values phi(n-1) and phi(n-2).
  let phi1 = 0;
  let phi2 = 0;
  let ccapPrevInd = 0;
  let indFirstCall = true;
  // true after stampCompanion has been called at least once
  let companionActive = false;

  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: true,
    setParam(_key: string, _value: number): void {},

    stamp(solver: SparseSolver): void {
      const k = branchIdx;

      // B sub-matrix: I_k flows INTO nodeA and OUT OF nodeB
      // (inductor branch current I_L flows from nodeA to nodeB)
      if (nodeA !== 0) solver.stamp(nodeA - 1, k, 1);
      if (nodeB !== 0) solver.stamp(nodeB - 1, k, -1);

      if (!companionActive) {
        // DC model: short circuit  →  V_A - V_B = 0
        // C sub-matrix enforces V_A - V_B = 0
        if (nodeA !== 0) solver.stamp(k, nodeA - 1, 1);
        if (nodeB !== 0) solver.stamp(k, nodeB - 1, -1);
        solver.stampRHS(k, 0);
      } else {
        // Companion model branch equation: V_A - V_B - geq * I_k = ieq
        // i.e.  +V_A - V_B - geq*I_k = ieq
        // C sub-matrix:
        if (nodeA !== 0) solver.stamp(k, nodeA - 1, 1);
        if (nodeB !== 0) solver.stamp(k, nodeB - 1, -1);
        // -geq coefficient on I_k (branch column k in the C block)
        solver.stamp(k, k, -geq);
        // RHS: ieq
        solver.stampRHS(k, ieq);
      }
    },

    stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array, order = 1, deltaOld: readonly number[] = []): void {
      // Read previous branch current I_L from solution.
      const iNow = voltages[branchIdx];
      const phi0 = inductance * iNow;
      const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
      const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
      // For BDF-1 (order=1): phi1 = phi0 so ccap=0, ceq = -L*iNow/dt.
      // For BDF-2: phi1 = L*i_prev (from previous step), phi2 = L*i_2prev.
      const phi1Eff = order <= 1 ? phi0 : (indFirstCall ? phi0 : phi1);
      const phi2Eff = order <= 1 ? phi0 : (indFirstCall ? phi0 : phi2);
      const result = integrateInductor(inductance, iNow, phi0, phi1Eff, phi2Eff, dt, h1, h2, order, method, indFirstCall ? 0 : ccapPrevInd);
      geq = result.geq;
      ieq = result.ceq;
      ccapPrevInd = result.ccap;

      // Save history for BDF-2.
      phi2 = indFirstCall ? phi0 : phi1;
      phi1 = phi0;
      indFirstCall = false;

      companionActive = true;
    },

    updateChargeFlux(voltages: Float64Array, dt: number, method: IntegrationMethod, order: number, deltaOld: readonly number[]): void {
      // Write ONLY the _NOW slot — never shift history (per interface contract).
      // Recompute ccap from converged current so the next step's trapezoidal
      // recursion starts from the correct companion current.
      const iNow = voltages[branchIdx];
      const phi0 = inductance * iNow;
      if (dt > 0) {
        const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
        const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
        const result = integrateInductor(inductance, iNow, phi0, phi1, phi2, dt, h1, h2, order, method, ccapPrevInd);
        ccapPrevInd = result.ccap;
      }
      // Do NOT shift phi1/phi2 — stampCompanion owns history advancement.
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
  const el = new AnalogCapacitorElement(capacitance);
  return withNodeIds(el, [nodeA, nodeB]);
}

/**
 * Create a real AnalogInductorElement for use in tests.
 * Parameter order differs from makeInductor: inductance first, then nodes, then branch.
 */
export function createTestInductor(inductance: number, nodeA: number, nodeB: number, branchIdx: number): AnalogElement {
  const el = new AnalogInductorElement(branchIdx, inductance);
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
  let scale = 1;
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    setSourceScale(factor: number): void {
      scale = factor;
    },
    setParam(_key: string, _value: number): void {},
    stamp(solver: SparseSolver): void {
      const k = branchIdx;
      const t = getTime();
      const v =
        (dcOffset + amplitude * Math.sin(2 * Math.PI * frequency * t + phase)) *
        scale;

      // B sub-matrix (node rows, branch column k)
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, k, -1);

      // C sub-matrix (branch row k, node columns)
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeNeg !== 0) solver.stamp(k, nodeNeg - 1, -1);

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
