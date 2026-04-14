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
    pool: { initMode: "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "transient" };
    /** Emit per-iteration phase begin label. */
    onModeBegin(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iteration: number): void;
    /** Emit per-iteration phase end label. */
    onModeEnd(phase: "dcopInitJct" | "dcopInitFix" | "dcopInitFloat", iteration: number, converged: boolean): void;
  } | null;
  /** Optional shared state pool for state0 damping (ngspice niiter.c). */
  statePool?: { state0: Float64Array } | null;
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
 * Each iteration:
 *  1. Clears the MNA matrix via `solver.beginAssembly`
 *  2. Stamps linear contributions (topology-constant)
 *  3. Stamps nonlinear contributions at the current operating point
 *  4. Finalizes and factors the matrix
 *  5. Solves for updated voltages
 *  6. Node damping (ngspice niiter.c, DCOP only): if max voltage change > 10 V,
 *     scale all updates down (min factor 0.1) to prevent runaway steps
 *  7. Updates operating points — elements apply voltage limiting and update
 *     their linearized companion model (geq/ieq) for the next iteration
 *  8. Checks global node-voltage convergence (ngspice NIconvTest) and
 *     element-specific checks
 *  9. Tracks the element/node with the largest voltage change for blame reporting
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
  const voltages = opts.voltagesBuffer ?? new Float64Array(matrixSize);
  if (opts.voltagesBuffer) voltages.fill(0);
  const prevVoltages = opts.prevVoltagesBuffer ?? new Float64Array(matrixSize);

  const statePool = opts.statePool ?? null;
  let oldState0: Float64Array | null = null;

  // Initialize from initial guess if provided
  if (opts.initialGuess) {
    voltages.set(opts.initialGuess);
  }

  // Detect whether any nonlinear elements are present.
  // A purely linear circuit solves exactly in one matrix solve; there is no
  // need to compare consecutive iterates — the first solution is the answer.
  const hasNonlinear = elements.some((el) => el.isNonlinear);

  // Initialize all nonlinear elements to the starting operating point
  // (sets up geq/ieq for the first stampNonlinear call)
  assembler.updateOperatingPoints(elements, voltages);

  // Stamp linear contributions once before the NR loop. These values are
  // operating-point-independent and identical on every iteration -- hoisting
  // them avoids redundant COO rebuilds and CSC scatters.
  // First iteration: full assembly establishes sparsity pattern + _cooToCsc.
  solver.beginAssembly(matrixSize);
  assembler.stampLinear(elements);
  // Capture the linear-only RHS and COO position before nonlinear stamps.
  const linearCooCount = solver.cooCount;
  solver.captureLinearRhs();

  assembler.stampNonlinear(elements);
  assembler.stampReactiveCompanion(elements);
  solver.finalize();
  // Snapshot CSC values for linear-only contributions (scatter-adds only
  // the linear COO portion [0, linearCooCount) into a separate buffer).
  solver.saveLinearBase(linearCooCount);

  // Hoist the iter-0 split hook into a local so the per-iteration hot path
  // pays nothing (not even a property lookup) when no harness is attached.
  const onIter0Complete = opts.onIteration0Complete;

  // dcopModeLadder: prime junctions before iter 0 and set initMode (niiter.c:991-993).
  const ladder = opts.dcopModeLadder ?? null;
  if (ladder) {
    ladder.pool.initMode = "initJct";
    ladder.runPrimeJunctions();
    // Re-run updateOperatingPoints so the primed junction seeds reach the stamp
    // (same as the old separate jctResult NR call: one updateOP at initJct).
    assembler.updateOperatingPoints(elements, voltages);
    // Re-stamp nonlinear with primed OP before iter 0.
    solver.restoreLinearBase();
    solver.setCooCount(linearCooCount);
    assembler.stampNonlinear(elements);
    assembler.stampReactiveCompanion(elements);
    solver.finalize(linearCooCount);
  }

  // Per-mode iteration counter for the initFix first-iter guard (Fix 3).
  // Tracks how many iterations have completed in the current ladder mode.
  // Resets to 0 on each mode transition (initJct→initFix, initFix→initFloat).
  // Starts at 0 — after the first iteration completes in initFix, ladderModeIter
  // becomes 1, allowing the noncon===0 check to fire on the *second* iteration,
  // matching ngspice's "iterno!=1" guard (niiter.c:885).
  let ladderModeIter = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Save previous voltages for convergence check
    prevVoltages.set(voltages);

    if (iteration === 0) {
      // First iteration: matrix already assembled above, no work needed.
    } else {
      // Subsequent iterations: restore the linear base (CSC values + RHS),
      // reset COO cursor to the linear boundary, re-stamp only nonlinear
      // contributions, and partial-refill CSC with nonlinear entries only.
      opts.preIterationHook?.(iteration, voltages);
      solver.restoreLinearBase();
      solver.setCooCount(linearCooCount);
      assembler.stampNonlinear(elements);
      assembler.stampReactiveCompanion(elements);
      solver.finalize(linearCooCount);
    }

    // 1b. Diagonal gmin augmentation (ngspice LoadGmin, spsmp.c:448-478):
    //     Add gmin to every diagonal element before factorization.
    if (opts.diagonalGmin) {
      solver.addDiagonalGmin(opts.diagonalGmin);
    }

    // 2. Factor — if singular, record and report non-convergence
    const factorResult = solver.factor();
    if (!factorResult.success) {
      diagnostics.emit(
        makeDiagnostic("singular-matrix", "error", "Singular matrix during NR iteration", {
          explanation: `The MNA matrix became singular at iteration ${iteration + 1}.`,
          suggestions: [],
        }),
      );
      return { converged: false, iterations: iteration + 1, voltages, largestChangeElement: -1, largestChangeNode: -1 };
    }

    // 3. Save state0 before solve for state0 damping (DO10)
    if (statePool) {
      if (!oldState0) {
        oldState0 = new Float64Array(statePool.state0.length);
      }
      oldState0.set(statePool.state0);
    }

    // 4. Solve for new voltages (written into voltages in-place)
    solver.solve(voltages);

    // 5. For purely linear circuits, the first solve gives the exact answer.
    //    Return immediately — no convergence iteration needed.
    //    Fire ladder mode transitions (initJct→initFix→initFloat) so the harness
    //    sees the correct phase sequence even for linear circuits. niiter.c runs
    //    MODEINITJCT→MODEINITFIX→MODEINITFLOAT unconditionally.
    if (!hasNonlinear) {
      opts.postIterationHook?.(iteration, voltages, prevVoltages, 0, true, true, [], []);
      if (ladder) {
        // initJct → initFix (niiter.c:991-993)
        ladder.onModeEnd("dcopInitJct", iteration, false);
        ladder.pool.initMode = "initFix";
        ladder.onModeBegin("dcopInitFix", iteration + 1);
        // initFix → initFloat (noncon===0, niiter.c:994-997)
        ladder.pool.initMode = "initFloat";
        ladder.onModeEnd("dcopInitFix", iteration + 1, false);
        ladder.onModeBegin("dcopInitFloat", iteration + 2);
        // Convergence in initFloat
        ladder.pool.initMode = "initFloat";
        ladder.onModeEnd("dcopInitFloat", iteration + 2, true);
      }
      return { converged: true, iterations: iteration + 1, voltages, largestChangeElement: -1, largestChangeNode: -1 };
    }

    // 5a. Update operating points BEFORE damping (DO12 reorder):
    //     elements apply voltage limiting, recompute their companion model
    //     (geq/ieq) for the next stampNonlinear. Sets assembler.noncon.
    //     Reset limitingCollector before each update so elements accumulate
    //     fresh events for this iteration.
    if (opts.limitingCollector != null) {
      opts.limitingCollector.length = 0;
    }
    assembler.updateOperatingPoints(elements, voltages, opts.limitingCollector ?? null);

    // 5b. Node damping (ngspice niiter.c:204-229):
    //     Guards: nodeDamping enabled, noncon != 0, isDcOp, iteration > 0.
    //     If any voltage node changed by more than 10V, scale ALL updates
    //     by 10/maxDelta. Minimum scale factor 0.1.
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

    // 5c. Convergence checks — skip when noncon > 0 or iteration === 0
    let globalConverged = false;
    let elemConverged = false;
    let largestChangeNode = 0;
    let largestChangeMag = 0;
    let convergenceFailedElements: string[] = [];

    if (assembler.noncon === 0 && iteration > 0) {
      // 6. Check global node-voltage convergence criterion (ngspice NIconvTest / niconv.c)
      //    tol = reltol * max(|old|, |new|) + absTol
      //    where absTol = abstol (VNTOL, 1e-6 V) for voltage rows,
      //          absTol = iabstol (ABSTOL, 1e-12 A) for branch-current rows.
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

      // 7. Element-specific convergence check
      if (opts.detailedConvergence) {
        const detailed = assembler.checkAllConvergedDetailed(elements, voltages, prevVoltages, reltol, iabstol);
        elemConverged = detailed.allConverged;
        convergenceFailedElements = detailed.failedIndices.map(i => elements[i].label ?? `element_${i}`);
      } else {
        elemConverged = assembler.checkAllConverged(elements, voltages, prevVoltages, reltol, iabstol);
      }
    } else if (assembler.noncon > 0 && iteration > 0 && opts.detailedConvergence) {
      // 7a. When noncon > 0, convergence already failed — but when
      //     detailedConvergence is requested, still collect per-element
      //     failure data for harness instrumentation.
      const detailed = assembler.checkAllConvergedDetailed(elements, voltages, prevVoltages, reltol, iabstol);
      elemConverged = false;
      convergenceFailedElements = detailed.failedIndices.map(i => elements[i].label ?? `element_${i}`);
    }

    // 8. Find element with largest contribution to non-convergence (blame tracking)
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

    // 9a. Post-iteration hook for external instrumentation
    const limitingEvents = opts.limitingCollector ?? [];
    opts.postIterationHook?.(iteration, voltages, prevVoltages, assembler.noncon, globalConverged, elemConverged, limitingEvents, convergenceFailedElements);

    // 9b. dcopModeLadder: emit end label for current mode, then transition.
    // Matches niiter.c:991-997 mode-switch logic that fires after each CKTload+solve.
    if (ladder) {
      const curMode = ladder.pool.initMode;
      const phaseLabel =
        curMode === "initJct" ? "dcopInitJct" :
        curMode === "initFix" ? "dcopInitFix" : "dcopInitFloat";

      let nextMode = curMode;
      if (curMode === "initJct") {
        // niiter.c:991-993: unconditional → initFix after iter 0
        nextMode = "initFix";
        ladderModeIter = 0;
      } else if (curMode === "initFix") {
        // niiter.c:994-997 + niiter.c:885-889: → initFloat only if noncon === 0
        // AND this is not the first iteration in initFix (ngspice forces noncon=1
        // when iterno==1, i.e. the first load in the current mode, preventing
        // MODEINITFIX from exiting on the very first iteration).
        // Mapping: ngspice iterno==1 ↔ our ladderModeIter==0 (0-indexed, resets
        // on each mode entry).
        if (assembler.noncon === 0 && ladderModeIter > 0) {
          nextMode = "initFloat";
          ladderModeIter = 0;
        }
      }
      // initFloat stays initFloat until convergence or exhaustion

      // Only emit phase handoff callbacks when mode actually changes.
      // Firing onModeEnd+onModeBegin on every iteration (even same-mode) would
      // split each iteration into its own 1-iter attempt in the harness.
      if (nextMode !== curMode) {
        ladder.onModeEnd(phaseLabel, iteration, globalConverged && elemConverged);
        ladder.pool.initMode = nextMode;
        const nextLabel =
          nextMode === "initJct" ? "dcopInitJct" :
          nextMode === "initFix" ? "dcopInitFix" : "dcopInitFloat";
        ladder.onModeBegin(nextLabel, iteration + 1);
      } else {
        // Same mode: increment the per-mode counter for the initFix first-iter guard.
        ladderModeIter++;
        // Still need to end the current attempt on terminal convergence
        // (initFloat converged). The convergence check below will return, so emit
        // the terminal end now so the harness records the correct outcome.
        const converged = globalConverged && elemConverged;
        const canConvergeNow = ladder.pool.initMode === "initFloat";
        if (canConvergeNow && converged) {
          ladder.onModeEnd(phaseLabel, iteration, true);
        }
      }
    }

    // 10. Return on convergence (niiter.c:986-989: only in MODEINITFLOAT).
    // When ladder is active, convergence is gated on initMode === "initFloat".
    // Without ladder, behaves as before.
    const canConverge = !ladder || ladder.pool.initMode === "initFloat";
    if (canConverge && globalConverged && elemConverged) {
      return { converged: true, iterations: iteration + 1, voltages, largestChangeElement, largestChangeNode };
    }

    // 10a. Split marker: after iteration 0 completes without converging, let
    //      the harness split the NR attempt into a cold-linearization phase
    //      ("dcopInitFloat", just iter 0) and a refinement phase ("dcopDirect",
    //      iterations 1..N). Mirrors ngspice's CKTop(firstmode, continuemode)
    //      two-pass structure. `onIter0Complete` is a hoisted local, so when
    //      no harness is attached the check below is a single register-level
    //      short-circuit and iteration > 0 pays nothing at all.
    if (onIter0Complete && iteration === 0) {
      onIter0Complete();
    }
  }

  return { converged: false, iterations: maxIterations, voltages, largestChangeElement: -1, largestChangeNode: -1 };
}

