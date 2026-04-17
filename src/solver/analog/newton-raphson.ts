/**
 * Newton-Raphson nonlinear iteration loop for MNA circuit simulation.
 *
 * Implements the core NR loop with separate linear/nonlinear stamp passes,
 * voltage limiting (pnjlim for PN junctions, fetlim for MOSFETs), global and
 * element-specific convergence checking, and blame tracking.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";
import { MNAAssembler } from "./mna-assembler.js";
import type { DiagnosticCollector } from "./diagnostics.js";
import { makeDiagnostic } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// LimitingEvent — records a single voltage-limiting call per junction per NR iteration
// ---------------------------------------------------------------------------

/**
 * Records one voltage-limiting function application (pnjlim, fetlim, or limvds)
 * on a specific junction of a specific element during one NR iteration.
 *
 * Elements push events into the NROptions.limitingCollector array after each
 * limiting function call. The NR loop resets the collector at the start of
 * each iteration.
 */
export interface LimitingEvent {
  /** Element index in compiled.elements[]. */
  elementIndex: number;
  /** Element label. */
  label: string;
  /** Junction name: "BE", "BC", "GS", "DS", "AK", etc. */
  junction: string;
  /** Limiting function applied. */
  limitType: "pnjlim" | "fetlim" | "limvds";
  /** Input voltage before limiting. */
  vBefore: number;
  /** Output voltage after limiting. */
  vAfter: number;
  /** Whether limiting was actually applied (vAfter differs from vBefore). */
  wasLimited: boolean;
}

// ---------------------------------------------------------------------------
// NROptions / NRResult
// ---------------------------------------------------------------------------

/**
 * Stamps 1e10 conductance to enforce nodeset and initial-condition constraints
 * on specific nodes. Called after CKTload (stampAll) during each NR iteration.
 *
 * Matches ngspice CKTnodeset/CKTic enforcement: large conductance to a known
 * voltage forces the node to that value during the early initJct/initFix phases.
 *
 * @param solver    - The sparse solver to stamp into.
 * @param nodesets  - Map of nodeId → target voltage for nodeset constraints.
 * @param ics       - Map of nodeId → target voltage for initial-condition constraints.
 * @param srcFact   - Source stepping scale factor (0..1). Applied to target voltages.
 * @param initMode  - Current NR init mode. Nodesets only stamp in initJct or initFix.
 */
export function applyNodesetsAndICs(
  solver: SparseSolver,
  nodesets: Map<number, number>,
  ics: Map<number, number>,
  srcFact: number,
  initMode: string,
): void {
  const G_NODESET = 1e10;
  if (initMode === "initJct" || initMode === "initFix") {
    for (const [nodeId, value] of nodesets) {
      solver.stamp(nodeId, nodeId, G_NODESET);
      solver.stampRHS(nodeId, G_NODESET * value * srcFact);
    }
  }
  for (const [nodeId, value] of ics) {
    solver.stamp(nodeId, nodeId, G_NODESET);
    solver.stampRHS(nodeId, G_NODESET * value * srcFact);
  }
}

/** Configuration for a single Newton-Raphson solve. */
export interface NROptions {
  /** Shared sparse solver instance (pre-configured for this circuit). */
  solver: SparseSolver;
  /** All analog elements in the circuit. */
  elements: readonly AnalogElement[];
  /** MNA matrix size = nodeCount + branchCount. */
  matrixSize: number;
  /**
   * Number of node-voltage rows at the front of the solution vector.
   * Damping is restricted to node rows only (0..nodeCount-1),
   * matching ngspice niiter.c which never damps branch-current rows.
   * Defaults to matrixSize when omitted.
   */
  nodeCount?: number;
  /** Maximum number of NR iterations before declaring failure. */
  maxIterations: number;
  /**
   * When true, use maxIterations as-is without the ngspice floor of 100.
   * Required for INITJCT/INITFIX DC op phases that need exactly 1 iteration
   * before transitioning modes (ngspice niiter.c:991-997).
   */
  exactMaxIterations?: boolean;
  /** Relative convergence tolerance. */
  reltol: number;
  /** Absolute voltage convergence tolerance in volts. */
  abstol: number;
  /** Absolute current tolerance for device convergence checks (ngspice ABSTOL). */
  iabstol: number;
  /**
   * Whether this solve is a DC operating point (DCOP/TRANOP).
   * Node damping is only applied during DC operating point solves,
   * matching ngspice niiter.c which skips damping during transient.
   * Defaults to false.
   */
  isDcOp?: boolean;
  /** Optional initial guess for the solution vector. */
  initialGuess?: Float64Array;
  /** Diagnostic collector for emitting solver events. */
  diagnostics: DiagnosticCollector;
  /**
   * Optional pre-allocated working buffer for the current voltages iterate.
   * When provided, newtonRaphson() reuses it instead of allocating a new
   * Float64Array per call. Must be at least `matrixSize` long. The caller
   * retains ownership; contents are overwritten on each call.
   */
  voltagesBuffer?: Float64Array;
  /**
   * Optional pre-allocated working buffer for the previous-iteration voltages.
   * Same contract as `voltagesBuffer`.
   */
  prevVoltagesBuffer?: Float64Array;
  /**
   * Optional gmin conductance to add to every diagonal of the assembled matrix
   * before factorization. Matches ngspice LoadGmin (spsmp.c:448-478).
   * Applied after finalize() and before factor() on each NR iteration.
   */
  diagonalGmin?: number;
  /** When true, compute per-element blame tracking (largestChangeElement). Only needed when convergence logging is active. */
  enableBlameTracking?: boolean;
  /**
   * DC operating point mode ladder (niiter.c:991-997).
   *
   * When provided, drives pool.initMode transitions inside the NR loop:
   *   - iter 0: pool.initMode set to "initJct"; runPrimeJunctions() fires once before iter 0.
   *   - after iter 0: unconditional transition to "initFix" (niiter.c:991-993).
   *   - iter N in initFix: transition to "initFloat" only if assembler.noncon === 0 (niiter.c:994-997).
   *   - convergence return restricted to initMode === "initFloat" (niiter.c:986-989).
   *
   * Phase labels emitted via onModeBegin/onModeEnd so the harness session
   * map shows dcopInitJct, dcopInitFix, dcopInitFloat per-iteration.
   */
  dcopModeLadder?: {
    /** Called before iteration 0 to prime junctions (MODEINITJCT). */
    runPrimeJunctions(): void;
    /** State pool reference for reading/writing initMode. */
    pool: { initMode: "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient" };
    /** Emit per-iteration phase begin label. */
    onModeBegin(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iteration: number): void;
    /** Emit per-iteration phase end label. */
    onModeEnd(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iteration: number, converged: boolean): void;
  } | null;
  /** Optional shared state pool for state0 damping (ngspice niiter.c). */
  statePool?: { state0: Float64Array; uic?: boolean } | null;
  /** Enable node damping in NR iteration (ngspice niiter.c). Default: false */
  nodeDamping?: boolean;
  /** Hook for per-iteration companion recomputation. Called on iteration > 0 before re-stamping. */
  preIterationHook?: (iteration: number, voltages: Float64Array) => void;
  /**
   * Hook called after each NR iteration's convergence check, before the
   * convergence return. Receives the full iteration state for external
   * instrumentation (comparison harness, convergence logging, etc.).
   *
   * Called unconditionally on every iteration (not just converged ones).
   * The hook must not mutate voltages or prevVoltages.
   *
   * The last two parameters carry harness instrumentation data:
   *   limitingEvents — events from opts.limitingCollector (or empty array when null)
   *   convergenceFailedElements — labels of elements that failed convergence this
   *     iteration (populated only when detailedConvergence is true, otherwise empty)
   */
  postIterationHook?: (
    iteration: number,
    voltages: Float64Array,
    prevVoltages: Float64Array,
    noncon: number,
    globalConverged: boolean,
    elemConverged: boolean,
    limitingEvents: LimitingEvent[],
    convergenceFailedElements: string[],
  ) => void;
  /**
   * Hook fired exactly once, after iteration 0's postIterationHook and before
   * iteration 1 begins. Lets the harness observe the cold linearization
   * (element load at the initial voltages) as a distinct sub-attempt before
   * the main NR refinement loop. No-op when NR returns in iteration 0 (linear
   * short-circuit or immediate convergence).
   */
  onIteration0Complete?: () => void;
  /**
   * When true, call checkAllConvergedDetailed instead of checkAllConverged.
   * Collects all failing element indices rather than short-circuiting.
   * Defaults to false — existing short-circuit path unchanged.
   */
  detailedConvergence?: boolean;
  /**
   * When non-null, elements push LimitingEvent objects here after each
   * limiting function call. The NR loop resets this array at the start
   * of each iteration before passing it to the assembler.
   * When null, elements skip limiting event collection (zero overhead).
   */
  limitingCollector?: LimitingEvent[] | null;
  /**
   * Nodeset constraints: map of MNA nodeId → target voltage.
   * Enforced via 1e10 conductance stamp during initJct and initFix phases.
   * See applyNodesetsAndICs().
   */
  nodesets?: Map<number, number>;
  /**
   * Initial condition constraints: map of MNA nodeId → target voltage.
   * Enforced via 1e10 conductance stamp on every iteration (unlike nodesets
   * which are restricted to initJct/initFix).
   * See applyNodesetsAndICs().
   */
  ics?: Map<number, number>;
  /**
   * Source stepping scale factor (ngspice srcFact). Applied to nodeset/IC
   * target voltages to ramp them in during source stepping. Default: 1.0.
   */
  srcFact?: number;
}

/** Result of a Newton-Raphson solve. */
export interface NRResult {
  /** Whether the iteration converged within maxIterations. */
  converged: boolean;
  /** Number of iterations performed. */
  iterations: number;
  /** Final solution vector (node voltages + branch currents). */
  voltages: Float64Array;
  /** Index of the element with the largest voltage change in the final iteration; -1 when unknown. */
  largestChangeElement: number;
  /** Index of the node with the largest voltage change in the final iteration; -1 when unknown. */
  largestChangeNode: number;
}

// ---------------------------------------------------------------------------
// Voltage limiting functions
// ---------------------------------------------------------------------------

/**
 * Result of a pnjlim call, matching ngspice DEVpnjlim output parameters.
 */
export interface PnjlimResult {
  value: number;
  limited: boolean;
}

/**
 * PN-junction voltage limiting (pnjlim).
 *
 * Prevents exponential runaway in diode/BJT junction voltage updates by
 * compressing large forward-bias steps logarithmically, and clamping
 * large reverse-bias steps.
 *
 * Matches ngspice DEVpnjlim (devsup.c:50-58) exactly, including the
 * `*icheck` output parameter exposed here as the `limited` field.
 *
 * @param vnew  - Proposed new junction voltage
 * @param vold  - Previous junction voltage
 * @param vt    - Thermal voltage (kT/q, ~0.02585 V at 300 K)
 * @param vcrit - Critical voltage above which limiting engages
 * @returns     - { value: limited voltage, limited: true if clipping was applied }
 */
/**
 * Module-level reusable result object for pnjlim(). Mutated and returned on
 * every call -- callers MUST extract .value and .limited before the next
 * pnjlim() call, as the object is shared. Single-threaded, safe.
 */
const _pnjlimResult: PnjlimResult = { value: 0, limited: false };

export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): PnjlimResult {
  let limited = false;
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    // Large forward-bias step: compress logarithmically to prevent exp() overflow
    if (vold > 0) {
      const arg = (vnew - vold) / vt;
      if (arg > 0) {
        vnew = vold + vt * (2 + Math.log(arg - 2));
      } else {
        vnew = vold - vt * (2 + Math.log(2 - arg));
      }
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
    limited = true;
  } else {
    // Reverse-bias limiting (ngspice devsup.c AlansFixes, lines 65-79)
    if (vnew < 0) {
      let arg: number;
      if (vold > 0) {
        arg = -vold - 1;
      } else {
        arg = 2 * vold - 1;
      }
      if (vnew < arg) {
        vnew = arg;
        limited = true;
      }
    }
  }
  _pnjlimResult.value = vnew;
  _pnjlimResult.limited = limited;
  return _pnjlimResult;
}

/**
 * MOSFET gate-source voltage limiting (fetlim).
 *
 * Three-zone algorithm from SPICE3f5/ngspice DEVfetlim (devsup.c):
 *
 *   Zone 1 — Deep ON (vold >= vto + 3.5):
 *     Decreasing: clamp to max(-delta, vtstlo); floor at vto + 2
 *     Increasing: clamp to +vtsthi
 *
 *   Zone 2 — Near threshold (vto <= vold < vto + 3.5):
 *     Decreasing: floor at vto - 0.5
 *     Increasing: cap at vto + 4
 *
 *   Zone 3 — OFF (vold < vto):
 *     Decreasing: clamp to -vtsthi
 *     Increasing toward threshold: clamp to vtstlo; hard cap at vto + 0.5
 *
 * @param vnew - Proposed new Vgs
 * @param vold - Previous Vgs
 * @param vto  - Threshold voltage
 * @returns    - Voltage-limited new Vgs
 */
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = Math.abs(vold - vto) + 1;
  const vtox = vto + 3.5;
  const delv = vnew - vold;

  if (vold >= vto) {
    // ON
    if (vold >= vtox) {
      // Deep on
      if (delv <= 0) {
        // Decreasing
        if (vnew >= vtox) {
          if (-delv > vtstlo) vnew = vold - vtstlo;
        } else {
          vnew = Math.max(vnew, vto + 2);
        }
      } else {
        // Increasing
        if (delv >= vtsthi) vnew = vold + vtsthi;
      }
    } else {
      // Near threshold
      if (delv <= 0) {
        vnew = Math.max(vnew, vto - 0.5);
      } else {
        vnew = Math.min(vnew, vto + 4);
      }
    }
  } else {
    // OFF
    if (delv <= 0) {
      if (-delv > vtsthi) vnew = vold - vtsthi;
    } else {
      const vtemp = vto + 0.5;
      if (vnew <= vtemp) {
        if (delv > vtstlo) vnew = vold + vtstlo;
      } else {
        vnew = vtemp;
      }
    }
  }
  return vnew;
}

/**
 * MOSFET drain-source voltage limiting (limvds).
 *
 * Prevents large Vds swings per NR iteration. Critical for switching
 * circuits where Vds can swing across the full supply range.
 *
 * Algorithm from SPICE3f5/ngspice DEVlimvds (devsup.c).
 *
 * @param vnew - Proposed new Vds
 * @param vold - Previous Vds
 * @returns    - Voltage-limited new Vds
 */
export function limvds(vnew: number, vold: number): number {
  if (vold >= 3.5) {
    if (vnew > vold) {
      vnew = Math.min(vnew, 3 * vold + 2);
    } else if (vnew < 3.5) {
      vnew = Math.max(vnew, 2);
    }
  } else {
    if (vnew > vold) {
      vnew = Math.min(vnew, 4);
    } else {
      vnew = Math.max(vnew, -0.5);
    }
  }
  return vnew;
}

// ---------------------------------------------------------------------------
// Newton-Raphson iteration loop
// ---------------------------------------------------------------------------

/**
 * Run the Newton-Raphson nonlinear iteration loop.
 *
 * Loop body follows ngspice NIiter ordering:
 *   A. Clear noncon + reset limit collector
 *   B. CKTload via assembler.stampAll (update OPs, stamp all elements)
 *   E. Factorize
 *   F. Solve
 *   H. Convergence check (global + element)
 *   I. Node damping (DCOP only)
 *   J. INITF dispatcher (mode transitions)
 *
 * Non-convergence is returned via the result object, never thrown. The caller
 * (DC operating point solver) decides the appropriate fallback strategy.
 *
 * @param opts - NR iteration options
 * @returns    - NRResult with convergence status, iterations, voltages, and blame scalars
 */
export function newtonRaphson(opts: NROptions): NRResult {
  const { solver, elements, matrixSize, maxIterations: rawMaxIter, reltol, abstol, iabstol, diagnostics } = opts;
  // ngspice niiter.c:37-38 — unconditional floor: if (maxIter < 100) maxIter = 100;
  // Bypassed when exactMaxIterations is set (INITJCT/INITFIX need exactly 1 iteration).
  const maxIterations = opts.exactMaxIterations ? rawMaxIter : Math.max(rawMaxIter, 100);
  const nodeCount = opts.nodeCount ?? matrixSize;

  const assembler = new MNAAssembler(solver);
  // Reuse caller-provided buffers when available to avoid per-call allocation
  // in the hot transient step loop. Zero the reused buffer so stale data from
  // a previous call cannot leak into the first iteration before `initialGuess`
  // or `solver.solve()` writes to it.
  let voltages = opts.voltagesBuffer ?? new Float64Array(matrixSize);
  if (opts.voltagesBuffer) voltages.fill(0);
  let prevVoltages = opts.prevVoltagesBuffer ?? new Float64Array(matrixSize);

  const statePool = opts.statePool ?? null;
  let oldState0: Float64Array | null = null;
  let ipass = 0;

  // Initialize from initial guess if provided.
  // Copy into prevVoltages because stampAll uses prevVoltages for device evaluation
  // (prevVoltages holds the "current best solution" via Step K pointer swap).
  if (opts.initialGuess) {
    prevVoltages.set(opts.initialGuess);
  }

  // Step D state: preorder runs at most once per solve.
  let didPreorder = false;

  // Hoist the iter-0 split hook into a local so the per-iteration hot path
  // pays nothing (not even a property lookup) when no harness is attached.
  const onIter0Complete = opts.onIteration0Complete;

  // dcopModeLadder: set initial initMode and prime junctions before iter 0.
  const ladder = opts.dcopModeLadder ?? null;
  if (ladder) {
    ladder.pool.initMode = "initJct";
    ladder.runPrimeJunctions();
  }

  // MODETRANOP && MODEUIC: single CKTload, no iteration (ngspice dctran.c UIC path).
  if (opts.isDcOp && opts.statePool?.uic) {
    [voltages, prevVoltages] = [prevVoltages, voltages];
    assembler.stampAll(elements, matrixSize, prevVoltages, null, 0);
    solver.finalize();
    return { converged: true, iterations: 0, voltages: prevVoltages, largestChangeElement: -1, largestChangeNode: -1 };
  }

  for (let iteration = 0; ; iteration++) {
    // ---- STEP A: Clear noncon + reset limit collector (ngspice CKTnoncon=0) ----
    assembler.noncon = 0;
    if (opts.limitingCollector != null) {
      opts.limitingCollector.length = 0;
    }

    // ---- STEP B: CKTload — unified device evaluation ----
    // On iteration 0, prevVoltages holds the initial guess (copied at entry).
    // On iteration 1+, prevVoltages holds the previous solve result (via Step K swap).
    opts.preIterationHook?.(iteration, prevVoltages);
    assembler.stampAll(elements, matrixSize, prevVoltages, opts.limitingCollector ?? null, iteration, voltages);

    // ---- STEP C: Nodeset/IC enforcement (ngspice CKTnodeset/CKTic) ----
    // Stamp 1e10 conductance for nodeset and IC nodes after CKTload,
    // then re-finalize so the new stamps are included in the CSC structure
    // before factorization.
    if (opts.nodesets?.size || opts.ics?.size) {
      const initPool = ladder ? ladder.pool : (opts.statePool as { initMode: string } | null);
      const curMode = initPool?.initMode ?? "transient";
      applyNodesetsAndICs(
        solver,
        opts.nodesets ?? new Map(),
        opts.ics ?? new Map(),
        opts.srcFact ?? 1.0,
        curMode,
      );
      solver.finalize();
    }

    // Diagonal gmin augmentation (ngspice LoadGmin, spsmp.c:448-478):
    // ---- STEP D: Preorder (once per solve) ----
    if (!didPreorder) {
      solver.preorder();
      didPreorder = true;
    }

    // Add gmin to every diagonal element before factorization.
    if (opts.diagonalGmin) {
      solver.addDiagonalGmin(opts.diagonalGmin);
    }

    // ---- STEP E: Factorize ----
    // ngspice niiter.c:888-891: E_SINGULAR on numerical-only path sets NISHOULDREORDER
    // and does `continue` (returns to top of for(;;), re-executes CKTload).
    // We must re-load before re-factoring so the matrix has fresh device stamps.
    const factorResult = solver.factor();
    if (!factorResult.success) {
      if (!solver.lastFactorUsedReorder) {
        // Numerical-only path failed (near-zero stored pivot). Force full reorder,
        // then continue to restart from Step A (re-execute CKTload before re-factoring).
        solver.forceReorder();
        continue;
      }
      diagnostics.emit(
        makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
          explanation: `The MNA matrix became singular at iteration ${iteration + 1}.`,
          suggestions: [],
        }),
      );
      return { converged: false, iterations: iteration + 1, voltages, largestChangeElement: -1, largestChangeNode: -1 };
    }

    // Save state0 before solve for state0 damping (DO10)
    if (statePool) {
      if (!oldState0) {
        oldState0 = new Float64Array(statePool.state0.length);
      }
      oldState0.set(statePool.state0);
    }

    // ---- STEP F: Solve ----
    solver.solve(voltages);

    // ---- STEP G: Check iteration limit BEFORE convergence (ngspice niiter.c:944) ----
    // iterno is 1-based (incremented during CKTload); iteration is 0-based.
    // Check: iterno > maxIter ↔ (iteration + 1) > maxIterations.
    if (iteration + 1 > maxIterations) {
      return { converged: false, iterations: iteration + 1, voltages, largestChangeElement: -1, largestChangeNode: -1 };
    }

    // ---- STEP H: Convergence check (ngspice NIconvTest) ----
    // ngspice niiter.c:957-961: iterno==1 forces noncon=1 (guarantees >= 2 iterations).
    // noncon was set by updateOperatingPoints inside stampAll; force on iteration 0.
    if (iteration === 0) {
      assembler.noncon = 1;
    }

    let globalConverged = false;
    let elemConverged = false;
    let largestChangeNode = 0;
    let largestChangeMag = 0;
    let convergenceFailedElements: string[] = [];

    if (assembler.noncon === 0 && iteration > 0) {
      // Global node-voltage convergence criterion (ngspice NIconvTest / niconv.c)
      //   tol = reltol * max(|old|, |new|) + absTol
      globalConverged = true;
      for (let i = 0; i < matrixSize; i++) {
        const delta = Math.abs(voltages[i] - prevVoltages[i]);
        if (delta > largestChangeMag) {
          largestChangeMag = delta;
          largestChangeNode = i;
        }
        const absTol = i < nodeCount ? abstol : iabstol;
        const tol = reltol * Math.max(Math.abs(voltages[i]), Math.abs(prevVoltages[i])) + absTol;
        if (delta > tol) {
          globalConverged = false;
        }
      }

      // Element-specific convergence check
      if (opts.detailedConvergence) {
        const detailed = assembler.checkAllConvergedDetailed(elements, voltages, prevVoltages, reltol, iabstol);
        elemConverged = detailed.allConverged;
        convergenceFailedElements = detailed.failedIndices.map(i => elements[i].label ?? `element_${i}`);
      } else {
        elemConverged = assembler.checkAllConverged(elements, voltages, prevVoltages, reltol, iabstol);
      }
    } else if (assembler.noncon > 0 && iteration > 0 && opts.detailedConvergence) {
      // When noncon > 0, convergence already failed — but when
      // detailedConvergence is requested, still collect per-element
      // failure data for harness instrumentation.
      const detailed = assembler.checkAllConvergedDetailed(elements, voltages, prevVoltages, reltol, iabstol);
      elemConverged = false;
      convergenceFailedElements = detailed.failedIndices.map(i => elements[i].label ?? `element_${i}`);
    }

    // ---- STEP I: Newton damping (ngspice niiter.c:204-229) ----
    // Guards: nodeDamping enabled, noncon != 0, isDcOp, iteration > 0
    if (opts.nodeDamping && assembler.noncon !== 0 && opts.isDcOp && iteration > 0) {
      let maxDelta = 0;
      for (let i = 0; i < nodeCount; i++) {
        const delta = Math.abs(voltages[i] - prevVoltages[i]);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (maxDelta > 10) {
        const dampFactor = Math.max(10 / maxDelta, 0.1);
        for (let i = 0; i < nodeCount; i++) {
          voltages[i] = prevVoltages[i] + dampFactor * (voltages[i] - prevVoltages[i]);
        }
        // DO10: damp state0 alongside voltages
        if (statePool && oldState0) {
          const s0 = statePool.state0;
          for (let i = 0; i < s0.length; i++) {
            s0[i] = oldState0[i] + dampFactor * (s0[i] - oldState0[i]);
          }
        }
      }
    }

    // Blame tracking: find element with largest contribution to non-convergence
    let largestChangeElement = -1;
    if (opts.enableBlameTracking) {
      let largestElemDelta = -1;
      for (let ei = 0; ei < elements.length; ei++) {
        const el = elements[ei];
        if (!el.isNonlinear) continue;
        let elDelta = 0;
        for (const ni of el.pinNodeIds) {
          if (ni > 0 && ni - 1 < matrixSize) {
            const d = Math.abs(voltages[ni - 1] - prevVoltages[ni - 1]);
            if (d > elDelta) elDelta = d;
          }
        }
        if (elDelta > largestElemDelta) {
          largestElemDelta = elDelta;
          largestChangeElement = ei;
        }
      }
    }

    // Post-iteration hook for external instrumentation
    const limitingEvents = opts.limitingCollector ?? [];
    opts.postIterationHook?.(iteration, voltages, prevVoltages, assembler.noncon, globalConverged, elemConverged, limitingEvents, convergenceFailedElements);

    // ---- STEP J: Unified INITF dispatcher (ngspice niiter.c:1050-1085) ----
    // Handles all 6 modes + convergence return with ipass guard.
    // Reads initMode from ladder.pool (DC-OP) or statePool (transient).
    const initPool = ladder ? ladder.pool : (opts.statePool as { initMode: string } | null);
    const curInitMode = initPool?.initMode ?? "transient";

    if (curInitMode === "initFloat" || curInitMode === "transient") {
      if (assembler.noncon === 0 && globalConverged && elemConverged) {
        if (ipass > 0) {
          ipass--;
          assembler.noncon = 1;
        } else {
          // Emit terminal ladder end before returning
          if (ladder) {
            const phaseLabel =
              curInitMode === "initJct" ? "dcopInitJct" as const :
              curInitMode === "initFix" ? "dcopInitFix" as const : "dcopInitFloat" as const;
            ladder.onModeEnd(phaseLabel, iteration, true);
          }
          return { converged: true, iterations: iteration + 1, voltages, largestChangeElement, largestChangeNode };
        }
      }
    } else if (curInitMode === "initJct") {
      if (initPool) initPool.initMode = "initFix";
      solver.forceReorder();
      if (ladder) {
        ladder.onModeEnd("dcopInitJct", iteration, false);
        ladder.onModeBegin("dcopInitFix", iteration + 1);
      }
    } else if (curInitMode === "initFix") {
      if (assembler.noncon === 0) {
        if (initPool) initPool.initMode = "initFloat";
        ipass = 1;
        if (ladder) {
          ladder.onModeEnd("dcopInitFix", iteration, false);
          ladder.onModeBegin("dcopInitFloat", iteration + 1);
        }
      }
    } else if (curInitMode === "initTran") {
      if (initPool) initPool.initMode = "initFloat";
      if (iteration <= 0) {
        solver.forceReorder();
      }
    } else if (curInitMode === "initPred") {
      if (initPool) initPool.initMode = "initFloat";
    } else if (curInitMode === "initSmsig") {
      if (initPool) initPool.initMode = "initFloat";
    }
    // No pool and no ladder: convergence is unrestricted (already handled
    // by curInitMode defaulting to "transient" above).

    // Split marker: after iteration 0, let the harness observe cold linearization
    if (onIter0Complete && iteration === 0) {
      onIter0Complete();
    }

    // ---- STEP K: Swap RHS vectors (O(1) pointer swap) ----
    // After swap: prevVoltages = this iteration's solution, voltages = scratch buffer.
    // Next iteration's stampAll will use prevVoltages for device evaluation.
    const tmp = voltages;
    voltages = prevVoltages;
    prevVoltages = tmp;
  }

  // After the final Step K swap, prevVoltages holds the last solution.
  return { converged: false, iterations: maxIterations, voltages: prevVoltages, largestChangeElement: -1, largestChangeNode: -1 };
}

