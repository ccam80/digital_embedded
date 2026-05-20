/**
 * AC Small-Signal Analysis Engine.
 *
 * Implements SPICE-style .AC analysis: given a converged DC operating point,
 * linearize all nonlinear elements at their operating points, then sweep
 * frequency to compute the complex transfer function H(f) = V_out(f) / V_in(f).
 *
 * The analysis uses the unified SparseSolver in complex mode (setComplex),
 * the same factor/solve code path as DC and transient. For each frequency:
 *   1. Reset matrix values (spClear), keeping structure across frequencies.
 *   2. Call element.stampAc(solver, omega) on every element.
 *   3. Inject 1+0j at the AC source branch.
 *   4. Factor and solve the complex system.
 *   5. Read node voltages for the requested output nodes.
 *
 * Passive element AC stamps:
 *   Resistor R:    Y = G = 1/R      (real admittance)
 *   Capacitor C:   Y = jωC          (imaginary admittance)
 *   Inductor L:    Y = 1/(jωL)      (imaginary admittance, negative imaginary part)
 *
 * Nonlinear elements stamp their small-signal conductances (gm, gds, gπ) from
 * the last NR iteration stored internally after DC OP convergence.
 */

import { SparseSolver } from "./sparse-solver.js";
import { DiagnosticCollector, makeDiagnostic } from "./diagnostics.js";
import { solveDcOperatingPoint } from "./dc-operating-point.js";
import { CKTCircuitContext } from "./ckt-context.js";
import { MODEAC, MODEUIC } from "./ckt-mode.js";
import type { AnalogElement } from "./element.js";
import type { DeviceFamily } from "./ngspice-load-order.js";
import type { SimulationParams } from "../../core/analog-engine-interface.js";
import type { Diagnostic } from "../../compile/types.js";
import { DEFAULT_SIMULATION_PARAMS, resolveSimulationParams } from "../../core/analog-engine-interface.js";
import { runByDeviceFamily } from "./family-dispatch.js";
import { defaultStampAcHandler, type AcHandlerCtx } from "./loaders/default-loaders.js";

// ---------------------------------------------------------------------------
// AcParams- frequency sweep configuration
// ---------------------------------------------------------------------------

/**
 * Parameters for an AC frequency sweep.
 */
export interface AcParams {
  /** Sweep type: linear, decades, or octaves. */
  type: "lin" | "dec" | "oct";
  /** Points per sweep unit (points per decade/octave for 'dec'/'oct', total points for 'lin'). */
  numPoints: number;
  /** Start frequency in Hz. */
  fStart: number;
  /** Stop frequency in Hz. */
  fStop: number;
  /** Label resolving to the MNA node where the AC stimulus is injected.
   *  Per the ngspice two-namespace contract: must be a label that maps
   *  unambiguously to a single node. For a 1-pin labeled element (Port,
   *  In, Out, Ground) use the bare label. For a multi-pin device (e.g. a
   *  voltage source `V1`) use the pin-form `V1:pos`- the bare device
   *  label has no node mapping under labelToNodeId. */
  sourceLabel: string;
  /** Labels resolving to MNA nodes to measure. Same contract as
   *  `sourceLabel`: bare label for 1-pin elements, `label:pinLabel` for
   *  individual pins on multi-pin devices. */
  outputNodes: string[];
}

// ---------------------------------------------------------------------------
// AcResult- frequency sweep result
// ---------------------------------------------------------------------------

/**
 * Result of an AC frequency sweep analysis.
 */
export interface AcResult {
  /** Frequency points in Hz. */
  frequencies: Float64Array;
  /** Magnitude |H(f)| per output node, in dB (20·log10|H|). */
  magnitude: Map<string, Float64Array>;
  /** Phase angle ∠H(f) per output node, in degrees. */
  phase: Map<string, Float64Array>;
  /** Real part Re{H(f)} per output node. */
  real: Map<string, Float64Array>;
  /** Imaginary part Im{H(f)} per output node. */
  imag: Map<string, Float64Array>;
  /** Diagnostics emitted during analysis. */
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// AcAnalysis
// ---------------------------------------------------------------------------

/**
 * Compiled circuit shape expected by AcAnalysis.
 */
export interface AcCompiledCircuit {
  readonly nodeCount: number;
  readonly matrixSize: number;
  readonly elements: readonly AnalogElement[];
  readonly elementsByFamily: ReadonlyMap<DeviceFamily, readonly AnalogElement[]>;
  readonly labelToNodeId: Map<string, number>;
}

/**
 * Optional AC-analysis dependencies. Tests inject a custom factory so a single
 * SparseSolver instance can be spied on across a sweep. Production callers omit
 * this and get a default SparseSolver. The factory's solver is reset
 * (_initStructure) and switched to complex mode (setComplex) by the analysis.
 */
export interface AcAnalysisDeps {
  /** Factory returning the SparseSolver used for the frequency sweep. */
  solverFactory?: () => SparseSolver;
  /**
   * Optional per-frequency snapshot sink. Called once per successful complex
   * solve with the loaded complex matrix CSC (captured pre-factor), the
   * loaded complex RHS (captured pre-solve), and the post-solve complex
   * solution, plus `freq`/`omega`/`matrixSize` metadata. All arrays are
   * defensive copies (sink owns them; safe to retain past the next
   * frequency point).
   *
   * Capture timing mirrors ngspice's AC bridge instrumentation
   * (niiter.c `ni_ac_capture_*` block): matrix is taken between
   * `runByDeviceFamily(stampAc, ...)` and `solver.factor()` (factor
   * overwrites `.Real`/`.Imag` with L/U), RHS is taken between
   * `solver.factor()` and `solver.solve()`, solution is taken after
   * `solve()`.
   *
   * Used by the parity harness to capture our-side AC data for comparison
   * against ngspice's per-frequency callback. Default `undefined`: zero cost
   * for production callers (no CSC walk, no array slicing).
   */
  acSnapshotSink?: (snap: {
    freq: number;
    omega: number;
    matrixSize: number;
    /** Complex Jacobian in external-coords CSC, pre-factor. */
    matrix: {
      nnz: number;
      colPtr: Int32Array;
      rowIdx: Int32Array;
      valsRe: Float64Array;
      valsIm: Float64Array;
    };
    /** Complex RHS real part, pre-solve. */
    rhsRe: Float64Array;
    /** Complex RHS imag part, pre-solve. */
    rhsIm: Float64Array;
    /** Post-solve complex solution real part. */
    solRe: Float64Array;
    /** Post-solve complex solution imag part. */
    solIm: Float64Array;
  }) => void;
}

/**
 * AC small-signal analysis.
 *
 * Usage:
 *   const ac = new AcAnalysis(compiled);
 *   const result = ac.run(params);
 */
export class AcAnalysis {
  private readonly _compiled: AcCompiledCircuit;
  private readonly _params: SimulationParams;
  private readonly _deps: AcAnalysisDeps;

  constructor(
    compiled: AcCompiledCircuit,
    params?: Partial<SimulationParams>,
    deps?: AcAnalysisDeps,
  ) {
    this._compiled = compiled;
    this._params = { ...DEFAULT_SIMULATION_PARAMS, ...params };
    this._deps = deps ?? {};
  }

  /**
   * Run AC analysis.
   *
   * Steps:
   *   1. Solve DC operating point to linearize nonlinear elements.
   *   2. Build frequency array from params.
   *   3. For each frequency, stamp complex admittances and solve.
   *   4. Extract transfer function at output nodes.
   */
  run(params: AcParams): AcResult {
    const { compiled, diagnostics } = this._setupAnalysis();

    // Step 1: Solve DC operating point
    const dcCtx = new CKTCircuitContext(compiled, resolveSimulationParams(this._params), () => {}, new SparseSolver());
    // Share the AC sweep's diagnostic collector so DC-OP diagnostics surface upstream.
    dcCtx.diagnostics = diagnostics;
    solveDcOperatingPoint(dcCtx);
    const dcResult = dcCtx.dcopResult;

    // After DC OP, nonlinear elements have their small-signal parameters set.
    // We don't need the DC voltages explicitly- they're baked into element state.

    // Step 2: Find AC source node
    const sourceNodeId = compiled.labelToNodeId.get(params.sourceLabel);
    if (sourceNodeId === undefined) {
      diagnostics.emit(
        makeDiagnostic("ac-no-source", "error", `AC source '${params.sourceLabel}' not found`, {
          explanation:
            `No node with label '${params.sourceLabel}' was found in the circuit. ` +
            "Specify a label that resolves to a single MNA node: a 1-pin " +
            "labeled element (Port, In, Out), or pin-form like `V1:pos` " +
            "for a specific terminal of a multi-pin device.",
        }),
      );
      return this._emptyResult(params, diagnostics.getDiagnostics());
    }

    // Emit diagnostic if DC OP did not converge (warn but proceed)
    if (!dcResult.converged) {
      diagnostics.emit(
        makeDiagnostic("convergence-failed", "warning", "DC operating point did not converge before AC sweep", {
          explanation:
            "AC small-signal analysis uses the DC operating point to linearize nonlinear elements. " +
            "The DC OP failed to converge; AC results may be inaccurate.",
        }),
      );
    }

    // Step 3: Build frequency array
    const frequencies = buildFrequencyArray(params);
    const numFreq = frequencies.length;

    // Step 4: Collect output node IDs
    const outputNodeIds = new Map<string, number>();
    for (const label of params.outputNodes) {
      const nodeId = compiled.labelToNodeId.get(label);
      if (nodeId !== undefined) {
        outputNodeIds.set(label, nodeId);
      }
    }

    // Allocate result arrays
    const magnitudeMap = new Map<string, Float64Array>();
    const phaseMap = new Map<string, Float64Array>();
    const realMap = new Map<string, Float64Array>();
    const imagMap = new Map<string, Float64Array>();

    for (const label of params.outputNodes) {
      magnitudeMap.set(label, new Float64Array(numFreq));
      phaseMap.set(label, new Float64Array(numFreq));
      realMap.set(label, new Float64Array(numFreq));
      imagMap.set(label, new Float64Array(numFreq));
    }

    // MNA system: nodes and branches occupy 1-based external indices 1..N
    // (ground = 0 = TrashCan, ngspice-faithful, identical to the DC/transient
    // solver). The ideal AC stimulus is an independent voltage source whose
    // branch equation gets one fresh index past every real unknown.
    const N = compiled.matrixSize;
    const branchExt = N + 1;          // synthetic AC source branch (1-based)

    // Caller-owned RHS / solution vectors (length N+2: indices 0..branchExt),
    // reused each frequency. SparseSolver.solve takes the real and imaginary
    // halves as separate parallel arrays (ngspice RHS / iRHS, Solution /
    // iSolution)- the halves are NOT adjacent.
    const rhsRe = new Float64Array(N + 2);
    const rhsIm = new Float64Array(N + 2);
    const solRe = new Float64Array(N + 2);
    const solIm = new Float64Array(N + 2);

    // Step 5: Frequency sweep- one unified SparseSolver in complex mode, the
    // same factor/solve code path as DC and transient (ngspice spSetComplex).
    const solver = this._deps.solverFactory
      ? this._deps.solverFactory()
      : new SparseSolver();
    solver._initStructure();
    solver.setComplex(true);

    // Handle cache for the AC voltage-source branch incidence stamps.
    // Allocated once on frequency 0, reused across the sweep.
    let acBranchHandleA = -1;
    let acBranchHandleB = -1;

    // acan.c:285: CKTmode = (CKTmode & MODEUIC) | MODEAC
    const acLoadCtx = dcCtx.loadCtx;
    acLoadCtx.cktMode = (dcCtx.cktMode & MODEUIC) | MODEAC;
    dcCtx.cktMode = acLoadCtx.cktMode;

    for (let fi = 0; fi < numFreq; fi++) {
      const f = frequencies[fi];
      const omega = 2 * Math.PI * f;

      // ngspice spClear- zero matrix values while keeping the linked
      // structure and pivot order across frequencies. Skipped on fi===0:
      // the structure does not exist yet; the first stamp pass builds it.
      if (fi !== 0) solver._resetForAssembly();

      // Stamp all elements' AC admittances via the family dispatcher.
      // Elements lazily allocate their matrix cells on the first stamp.
      // cite: acan.c:409-414 -- per-type DEVacLoad loop.
      const acHandlerCtx: AcHandlerCtx = { solver, omega, loadCtx: acLoadCtx };
      runByDeviceFamily(compiled.elementsByFamily, "stampAc", acHandlerCtx, defaultStampAcHandler);

      // Ideal AC voltage source V(sourceNode) = 1+0j (sourceNode → ground):
      //   (sourceNode, branch) += 1   node KCL picks up the branch current
      //   (branch, sourceNode) += 1   branch eqn: V(sourceNode) = E
      //   RHS[branch] = 1+0j          the 1 V AC stimulus (real, imag 0)
      // Re-stamped every frequency- spClear zeroed the +1 incidence values.
      if (sourceNodeId >= 1) {
        if (fi === 0) {
          acBranchHandleA = solver.allocElement(sourceNodeId, branchExt);
          acBranchHandleB = solver.allocElement(branchExt, sourceNodeId);
        }
        solver.stampElement(acBranchHandleA, 1.0);
        solver.stampElement(acBranchHandleB, 1.0);
      }
      rhsRe.fill(0);
      rhsIm.fill(0);
      rhsRe[branchExt] = 1.0;

      // Harness matrix capture (pre-factor)- mirrors ngspice's
      // ni_ac_capture_matrix(ckt) hook in niiter.c, fired between CKTacLoad
      // and SMPcLUfac. Captured into a local var here; passed to the sink
      // after solve so all per-frequency data lands in one call. The CSC
      // build (sort by col asc, then row asc; colPtr by prefix-sum) matches
      // ngspice's pre-LU CSC layout in the C-side ni_ac_capture_matrix.
      let snapshotMatrix: {
        nnz: number;
        colPtr: Int32Array;
        rowIdx: Int32Array;
        valsRe: Float64Array;
        valsIm: Float64Array;
      } | null = null;
      if (this._deps.acSnapshotSink) {
        const cells = solver.getComplexCSCNonZeros();
        const nnz = cells.length;
        // Standard CSC convention (matches ngspice's pre-LU CSC layout in
        // niiter.c): `colPtr[c]` is the END of column c's cells (= start of
        // column c+1); column c's non-zeros live at indices
        // [colPtr[c-1], colPtr[c]). `colPtr[0]` is always 0; the synthetic
        // AC source branch occupies column N+1, so `colPtr` has length N+2
        // (indices 0..N+1) and `colPtr[N+1]` is the terminating `nnz`
        // sentinel.
        const colPtr = new Int32Array(N + 2);
        const rowIdx = new Int32Array(nnz);
        const valsRe = new Float64Array(nnz);
        const valsIm = new Float64Array(nnz);
        cells.sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row);
        let cursor = 0;
        for (let c = 1; c <= N + 1; c++) {
          while (cursor < nnz && cells[cursor].col === c) {
            rowIdx[cursor] = cells[cursor].row;
            valsRe[cursor] = cells[cursor].valueRe;
            valsIm[cursor] = cells[cursor].valueIm;
            cursor++;
          }
          colPtr[c] = cursor;
        }
        snapshotMatrix = { nnz, colPtr, rowIdx, valsRe, valsIm };
      }

      // ngspice spFactor: fi===0 reorders (spOrderAndFactor, complex path);
      // subsequent frequencies reuse the pivot order (FactorComplexMatrix).
      // spOKAY === 0; any nonzero is an error (singular etc.).
      const err = solver.factor();

      if (err === 0) {
        // Harness RHS capture (pre-solve)- mirrors ni_ac_capture_loaded_rhs.
        // solve() reads rhsRe/rhsIm and writes solRe/solIm (separate buffers),
        // so capturing here is timing-equivalent to capturing after solve;
        // doing it pre-solve matches the C-side fire-order exactly.
        const snapshotRhsRe = this._deps.acSnapshotSink ? rhsRe.slice() : null;
        const snapshotRhsIm = this._deps.acSnapshotSink ? rhsIm.slice() : null;

        solRe.fill(0);
        solIm.fill(0);
        // ngspice spSolve(Matrix, RHS, Solution, iRHS, iSolution).
        solver.solve(rhsRe, solRe, rhsIm, solIm);

        // Extract transfer function at each output node (1-based index).
        for (const [label, nodeId] of outputNodeIds) {
          if (nodeId >= 1 && nodeId <= N) {
            const re = solRe[nodeId];
            const im = solIm[nodeId];
            const mag = Math.sqrt(re * re + im * im);
            const magDb = mag > 0 ? 20 * Math.log10(mag) : -300;
            const phaseDeg = (Math.atan2(im, re) * 180) / Math.PI;

            realMap.get(label)![fi] = re;
            imagMap.get(label)![fi] = im;
            magnitudeMap.get(label)![fi] = magDb;
            phaseMap.get(label)![fi] = phaseDeg;
          }
        }

        // Harness snapshot hook: emit defensive copies of the full
        // per-frequency capture (matrix pre-factor, RHS pre-solve, solution
        // post-solve). The bridge mirrors the ngspice per-frequency
        // callback; pairing happens by frequency index in ComparisonSession.
        if (this._deps.acSnapshotSink && snapshotMatrix) {
          this._deps.acSnapshotSink({
            freq: f,
            omega,
            matrixSize: N,
            matrix: snapshotMatrix,
            rhsRe: snapshotRhsRe!,
            rhsIm: snapshotRhsIm!,
            solRe: solRe.slice(),
            solIm: solIm.slice(),
          });
        }
      }
      // On solver failure at this frequency: leave arrays at 0 (already initialized)
    }

    return {
      frequencies,
      magnitude: magnitudeMap,
      phase: phaseMap,
      real: realMap,
      imag: imagMap,
      diagnostics: diagnostics.getDiagnostics(),
    };
  }

  private _setupAnalysis(): {
    compiled: AcCompiledCircuit;
    diagnostics: DiagnosticCollector;
  } {
    const diagnostics = new DiagnosticCollector();
    return { compiled: this._compiled, diagnostics };
  }

  private _emptyResult(params: AcParams, diagList: Diagnostic[]): AcResult {
    const frequencies = buildFrequencyArray(params);
    const n = frequencies.length;
    const magnitude = new Map<string, Float64Array>();
    const phase = new Map<string, Float64Array>();
    const real = new Map<string, Float64Array>();
    const imag = new Map<string, Float64Array>();
    for (const label of params.outputNodes) {
      magnitude.set(label, new Float64Array(n));
      phase.set(label, new Float64Array(n));
      real.set(label, new Float64Array(n));
      imag.set(label, new Float64Array(n));
    }
    return { frequencies, magnitude, phase, real, imag, diagnostics: diagList };
  }
}

// ---------------------------------------------------------------------------
// buildFrequencyArray- generate frequency points for a sweep
// ---------------------------------------------------------------------------

/**
 * Generate the frequency array for an AC sweep.
 *
 * - 'lin': numPoints equally-spaced from fStart to fStop (inclusive).
 * - 'dec': numPoints per decade; total = ceil(log10(fStop/fStart)) * numPoints.
 * - 'oct': numPoints per octave; total = ceil(log2(fStop/fStart)) * numPoints.
 */
export function buildFrequencyArray(params: AcParams): Float64Array {
  const { type, numPoints, fStart, fStop } = params;

  if (type === "lin") {
    const n = Math.max(1, numPoints);
    const freqs = new Float64Array(n);
    if (n === 1) {
      freqs[0] = fStart;
    } else {
      const step = (fStop - fStart) / (n - 1);
      for (let i = 0; i < n; i++) {
        freqs[i] = fStart + i * step;
      }
    }
    return freqs;
  }

  if (type === "dec") {
    const decades = Math.log10(fStop / fStart);
    const total = Math.round(decades * numPoints);
    const freqs = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      freqs[i] = fStart * Math.pow(10, (i / numPoints));
    }
    return freqs;
  }

  // 'oct'
  const octaves = Math.log2(fStop / fStart);
  const total = Math.round(octaves * numPoints);
  const freqs = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    freqs[i] = fStart * Math.pow(2, i / numPoints);
  }
  return freqs;
}
