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

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import { pnjlim } from "./newton-raphson.js";

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
    nodeIndices: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: SparseSolver): void {
      G(solver, nodeA, nodeA, G_val);
      G(solver, nodeA, nodeB, -G_val);
      G(solver, nodeB, nodeA, -G_val);
      G(solver, nodeB, nodeB, G_val);
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
    nodeIndices: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    setSourceScale(factor: number): void {
      scale = factor;
    },
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
    nodeIndices: [nodePos, nodeNeg],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setSourceScale(factor: number): void {
      scale = factor;
    },
    stamp(solver: SparseSolver): void {
      RHS(solver, nodePos, current * scale);
      RHS(solver, nodeNeg, -(current * scale));
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
): AnalogElement {
  const nVt = n * VT;
  const vcrit = nVt * Math.log(nVt / (is * Math.SQRT2));

  let vd = 0;    // current operating-point junction voltage
  let geq = GMIN; // linearized conductance
  let ieq = 0;   // Norton equivalent current offset

  return {
    nodeIndices: [nodeAnode, nodeCathode],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear (topology-constant) contributions for a diode.
    },

    stampNonlinear(solver: SparseSolver): void {
      // Stamp companion model: conductance geq in parallel, Norton offset ieq
      // Current flows from anode to cathode when vd > 0.
      // G sub-matrix (conductance between anode and cathode):
      G(solver, nodeAnode, nodeAnode, geq);
      G(solver, nodeAnode, nodeCathode, -geq);
      G(solver, nodeCathode, nodeAnode, -geq);
      G(solver, nodeCathode, nodeCathode, geq);
      // RHS: Norton current source (ieq flows from cathode to anode through element)
      RHS(solver, nodeAnode, -ieq);
      RHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // Apply pnjlim to prevent exponential runaway.
      // Write the limited junction voltage back into voltages[] so that:
      //   (a) the global convergence check operates on limited voltages,
      //   (b) the next stampNonlinear call sees a companion model built from
      //       a physically reasonable operating point.
      const vdLimited = pnjlim(vdRaw, vd, nVt, vcrit);

      // Adjust the anode node voltage by the limiting delta (cathode stays fixed)
      if (nodeAnode > 0) {
        voltages[nodeAnode - 1] = vc + vdLimited;
      }
      // If cathode is not ground, also adjust (rare for basic diode tests)
      // For the standard anode-limited case above this is sufficient.

      vd = vdLimited;

      // Shockley equation and NR linearization at limited operating point
      const expArg = vd / nVt;
      // Clamp exponent to avoid Float64 overflow (exp(>709) = Infinity)
      const clampedArg = Math.min(expArg, 700);
      const expVal = Math.exp(clampedArg);
      const id = is * (expVal - 1);
      geq = (is * expVal) / nVt + GMIN;
      ieq = id - geq * vd;
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdNew = va - vc;

      const vaPrev = nodeAnode > 0 ? prevVoltages[nodeAnode - 1] : 0;
      const vcPrev = nodeCathode > 0 ? prevVoltages[nodeCathode - 1] : 0;
      const vdPrev = vaPrev - vcPrev;

      // Converged when junction voltage change is within tolerance
      return Math.abs(vdNew - vdPrev) <= 2 * nVt;
    },
  };
}
