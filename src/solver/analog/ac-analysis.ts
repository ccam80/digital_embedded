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
import { MODEAC, MODEUIC, MODEDCOP, MODEINITJCT } from "./ckt-mode.js";
import type { AnalogElement } from "./element.js";
import type { DeviceFamily } from "./ngspice-load-order.js";
import type { SimulationParams } from "../../core/analog-engine-interface.js";
import type { Diagnostic } from "../../compile/types.js";
import { runByDeviceFamily } from "./family-dispatch.js";
import { defaultStampAcHandler, type AcHandlerCtx } from "./loaders/default-loaders.js";

// ---------------------------------------------------------------------------
// AcParams- frequency sweep configuration
// ---------------------------------------------------------------------------

/**
 * Parameters for an AC frequency sweep.
 *
 * The AC stimulus is read directly from each independent V/I source's
 * `AC <mag> [<phase>]` token (acMagnitude / acPhase properties), stamped
 * into the complex RHS by each device's `stampAc` per vsrcacld.c:175-180
 * and isrcacld.c:43-50. There is no separate "source label" — to drive
 * the sweep, place an AC source in the circuit and set its acMagnitude
 * to a non-zero value (default 1 mirrors ngspice VSRCacMag default,
 * vsrctemp.c:39).
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
  /** Labels resolving to MNA nodes to measure. Per the ngspice two-namespace
   *  contract: must be a label that maps unambiguously to a single node. For
   *  a 1-pin labeled element (Port, In, Out) use the bare label; for a
   *  specific terminal on a multi-pin device use the pin-form `V1:pos`. */
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
   * The engine's setup-allocated circuit context, used for the DC operating
   * point that precedes the frequency sweep.
   *
   * ngspice runs CKTop (DC-OP) and CKTacLoad on the SAME `ckt` over the SAME
   * matrix: CKTsetup builds one matrix (TSTALLOC) that DC and AC reuse, so the
   * DC-OP linearizes every nonlinear device into the exact element-state slots
   * (`VDMOSgm`, `VDMOScapgs`, …) that the per-frequency acLoad later reads. The
   * AC analysis MUST share that one context: each element's setup()-cached
   * matrix handles address cells in this context's solver, and only a DC-OP run
   * against this same solver leaves finite gm/gds/cap state behind.
   *
   * Injected by `MNAEngine.acAnalysis` (`deps.cktContext = this._ctx`). The
   * caller is responsible for having run `_setup()` (TSTALLOC + buffer sizing)
   * before handing the context over; AcAnalysis sets the DC-OP analysis mode
   * and runs `solveDcOperatingPoint` on it. Required- there is no fresh-context
   * path, because a fresh `SparseSolver` has none of the element handles
   * and would silently mis-stamp every nonlinear device (all-NaN solution).
   */
  cktContext?: CKTCircuitContext;
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
  private readonly _deps: AcAnalysisDeps;

  /**
   * @param compiled - Adapted compiled-circuit view (matrixSize, elements, …).
   * @param _params  - Simulation params. Retained on the constructor signature
   *   for call-site symmetry with the engine, but unused: the DC operating
   *   point runs on `deps.cktContext`, whose params the engine has already
   *   resolved and bound (ngspice runs CKTop + CKTacLoad on one ckt that owns
   *   the option set). The per-frequency sweep reads no analysis tolerances of
   *   its own.
   * @param deps - solver / DC-OP context / snapshot-sink injection.
   */
  constructor(
    compiled: AcCompiledCircuit,
    _params?: Partial<SimulationParams>,
    deps?: AcAnalysisDeps,
  ) {
    this._compiled = compiled;
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

    // Step 1: Solve DC operating point on the engine's setup-allocated context.
    //
    // ngspice acan.c calls CKTop(ckt, ...) (the DC-OP) and then CKTacLoad on
    // the SAME ckt over the SAME matrix that CKTsetup built (TSTALLOC). The
    // DC-OP linearizes every nonlinear device into its element-state slots
    // (VDMOSgm / VDMOScapgs / …) and the per-frequency acLoad reads those exact
    // slots back. We mirror that by running the DC-OP on the engine context
    // injected via deps.cktContext: its solver is the one each element's
    // setup()-cached matrix handles address, so the DC-OP stamps land in the
    // right cells and leave finite gm/gds/cap state behind. A fresh
    // SparseSolver has none of those handles- stamping through them mis-routes
    // every nonlinear device and yields an all-NaN AC solution.
    const dcCtx = this._deps.cktContext;
    if (!dcCtx) {
      throw new Error(
        "AcAnalysis requires the engine's setup-allocated context via " +
        "deps.cktContext (injected by MNAEngine.acAnalysis). The DC operating " +
        "point that precedes the sweep must run on the same TSTALLOC'd matrix " +
        "the elements' setup() handles address- a fresh context mis-stamps " +
        "nonlinear devices. Run AC through the engine/coordinator.",
      );
    }
    // Share the AC sweep's diagnostic collector so DC-OP diagnostics surface upstream.
    dcCtx.diagnostics = diagnostics;
    // dcop.c:82 — firstmode = (CKTmode & MODEUIC) | MODEDCOP | MODEINITJCT.
    // Mirror MNAEngine.dcOperatingPoint()'s analysis-mode and integration-state
    // preconditions: standalone .OP is MODEDCOP (not MODETRANOP); ag[0]=ag[1]=0
    // and srcFact=1 and loadCtx.dt=0 are the implicit DCOP-entry invariants
    // ngspice maintains (dctran.c:348 zeroes CKTag; CKTsrcFact enters at 1).
    const uicBit = dcCtx.cktMode & MODEUIC;
    dcCtx.cktMode = uicBit | MODEDCOP | MODEINITJCT;
    dcCtx.srcFact = 1;
    dcCtx.ag[0] = 0;
    dcCtx.ag[1] = 0;
    dcCtx.loadCtx.dt = 0;
    solveDcOperatingPoint(dcCtx);
    const dcResult = dcCtx.dcopResult;

    // After DC OP, nonlinear elements have their small-signal parameters set.
    // We don't need the DC voltages explicitly- they're baked into element state.

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
    // solver). The AC stimulus is read directly from each independent V/I
    // source via its `stampAc` (vsrcacld.c:175-180, isrcacld.c:43-50); there
    // is no synthetic branch- matrix dimension equals N, not N+1.
    const N = compiled.matrixSize;

    // Caller-owned RHS / solution vectors (length N+1: indices 0..N, with
    // slot 0 = ground sentinel matching ngspice's CKTrhs / CKTirhs layout),
    // reused each frequency. SparseSolver.solve takes the real and imaginary
    // halves as separate parallel arrays (ngspice RHS / iRHS, Solution /
    // iSolution)- the halves are NOT adjacent.
    const rhsRe = new Float64Array(N + 1);
    const rhsIm = new Float64Array(N + 1);
    const solRe = new Float64Array(N + 1);
    const solIm = new Float64Array(N + 1);

    // Step 5: Frequency sweep- one unified SparseSolver in complex mode, the
    // same factor/solve code path as DC and transient (ngspice spSetComplex).
    // ngspice builds one matrix via CKTsetup (TSTALLOC) and reuses it for DC
    // and AC- CKTacLoad (acan.c -> NIacIter -> CKTacLoad) writes the same
    // matrix pointers DEVsetup allocated. AcAnalysis mirrors that: it stamps
    // into the engine's setup-allocated solver (injected by MNAEngine.
    // acAnalysis via solverFactory), so every element's setup()-cached handles
    // address the right cells and the AC matrix structure/ordering equals the
    // DC (= ngspice) ordering. There is no separate "build a fresh AC matrix"
    // path- AC always reuses the one matrix, exactly as ngspice does.
    if (!this._deps.solverFactory) {
      throw new Error(
        "AcAnalysis requires the engine's setup-allocated solver via " +
        "deps.solverFactory (injected by MNAEngine.acAnalysis). Run AC through " +
        "the engine/coordinator- direct construction is unsupported.",
      );
    }
    const solver = this._deps.solverFactory();
    solver.setComplex(true);

    // acan.c:285: CKTmode = (CKTmode & MODEUIC) | MODEAC
    const acLoadCtx = dcCtx.loadCtx;
    acLoadCtx.cktMode = (dcCtx.cktMode & MODEUIC) | MODEAC;
    dcCtx.cktMode = acLoadCtx.cktMode;

    for (let fi = 0; fi < numFreq; fi++) {
      const f = frequencies[fi];
      const omega = 2 * Math.PI * f;

      // ngspice spClear (spbuild.c)- zero matrix values while keeping the
      // linked structure and pivot order across frequencies. The structure is
      // the engine's setup-allocated matrix, so it is cleared before every
      // stamp pass (the engine's prior DC/transient values must not leak into
      // the first AC frequency).
      solver._resetForAssembly();

      // Zero the complex RHS before stamping. AC sources (V/I) accumulate
      // their `AC <mag> [<phase>]` contributions via stampAc directly into
      // these arrays per vsrcacld.c:179-180 and isrcacld.c:43-50.
      rhsRe.fill(0);
      rhsIm.fill(0);

      // Stamp all elements' AC admittances and RHS contributions via the
      // family dispatcher. Elements lazily allocate their matrix cells on
      // the first stamp.
      // cite: acan.c:409-414 -- per-type DEVacLoad loop.
      const acHandlerCtx: AcHandlerCtx = { solver, omega, loadCtx: acLoadCtx, rhsRe, rhsIm };
      runByDeviceFamily(compiled.elementsByFamily, "stampAc", acHandlerCtx, defaultStampAcHandler);

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
        // [colPtr[c-1], colPtr[c]). `colPtr[0]` is always 0. The matrix
        // spans columns 1..N (N == compiled.matrixSize), so `colPtr` has
        // length N+1 (indices 0..N) and `colPtr[N]` is the terminating
        // `nnz` sentinel.
        const colPtr = new Int32Array(N + 1);
        const rowIdx = new Int32Array(nnz);
        const valsRe = new Float64Array(nnz);
        const valsIm = new Float64Array(nnz);
        cells.sort((a, b) => a.col !== b.col ? a.col - b.col : a.row - b.row);
        let cursor = 0;
        for (let c = 1; c <= N; c++) {
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

      // ngspice acan.c: the first AC point re-derives the pivot order in the
      // complex domain (NIacIter -> SMPcReorder -> spOrderAndFactor), then each
      // subsequent point reuses that order (SMPcLUfac -> FactorComplexMatrix).
      // The reorder at fi===0 is mandatory here even though the shared solver
      // already carries a factorization: the preceding DC-OP factored it in the
      // REAL domain (real-only L/U + a real-derived pivot order), so the matrix
      // arrives at the sweep with _needsReorder=false. spFactor's reuse loop
      // would refactor the real LU without ever building the complex
      // factorization, leaving every solve NaN. orderAndFactor() (spOrderAndFactor)
      // re-derives the order against the freshly-stamped complex matrix, which
      // is what ngspice does at the first AC frequency. spOKAY === 0; any
      // nonzero is an error (singular etc.).
      const err = fi === 0 ? solver.orderAndFactor() : solver.factor();

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
          // niiter.c:492 `d.freq = ckt->CKTomega / (2 * M_PI)`.
          this._deps.acSnapshotSink({
            freq: omega / (2 * Math.PI),
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

    // Restore the shared engine solver to real mode + cleared values so a
    // later DC/transient pass is unaffected by the AC sweep's complex state.
    solver.setComplex(false);
    solver._resetForAssembly();

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
}

// ---------------------------------------------------------------------------
// buildFrequencyArray- generate frequency points for a sweep
// ---------------------------------------------------------------------------

/**
 * Generate the frequency array for an AC sweep.
 *
 * Counts and spacing mirror ngspice acan.c (CKTacAnalyze) exactly:
 *
 *   DEC: num_steps = floor(|log10(fStop/fStart)| * numPointsPerDecade);
 *        freqDelta = exp(log(fStop/fStart) / num_steps);
 *        emit num_steps + 1 points from fStart to fStart * freqDelta^num_steps
 *        (= fStop exactly, modulo float rounding). Endpoint inclusive.
 *   OCT: num_steps = floor(|log2 (fStop/fStart)| * numPointsPerOctave);
 *        freqDelta = exp(log(2) / numPointsPerOctave);
 *        emit num_steps + 1 points (endpoint inclusive). Note ngspice's OCT
 *        freqDelta does NOT depend on fStop- it is a fixed octave step- so
 *        the last point can fall slightly past fStop when (log2(fStop/fStart)
 *        * numPoints) is not integer; the while-loop terminates at
 *        `freq <= stopFreq + freqTol` (acan.c:257). We match the integer
 *        endpoint via num_steps + 1 emission.
 *   LIN: numPoints equally-spaced from fStart to fStop (endpoint inclusive,
 *        ngspice's num_steps frequencies with step = (fStop-fStart)/(n-1)).
 *
 * Citation: ngspice acan.c:84-115 (freqDelta setup) and acan.c:227-389
 * (the sweep while-loop). The endpoint-inclusive count was off-by-one in
 * an earlier version of this function (emitted num_steps without the +1);
 * the ac-bridge-paired smoke caught it on the first real ngspice run.
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
    // ngspice acan.c:89 num_steps = floor(|log10(stop/start)| * n_per_dec).
    // freqDelta from acan.c:90; we emit fStart * freqDelta^i for
    // i = 0..num_steps (inclusive) to mirror the C-side sweep loop's
    // endpoint behaviour.
    const numSteps = Math.floor(Math.abs(Math.log10(fStop / fStart)) * numPoints);
    const freqDelta = Math.exp(Math.log(fStop / fStart) / numSteps);
    const total = numSteps + 1;
    const freqs = new Float64Array(total);
    freqs[0] = fStart;
    for (let i = 1; i < total; i++) {
      freqs[i] = freqs[i - 1] * freqDelta;
    }
    return freqs;
  }

  // 'oct'- ngspice acan.c:98-99 freqDelta = exp(log(2)/n_per_octave);
  // num_steps mirrors the DEC case (floor of log2 span * n_per_octave),
  // with num_steps + 1 emission.
  const numSteps = Math.floor(Math.abs(Math.log2(fStop / fStart)) * numPoints);
  const freqDelta = Math.exp(Math.log(2) / numPoints);
  const total = numSteps + 1;
  const freqs = new Float64Array(total);
  freqs[0] = fStart;
  for (let i = 1; i < total; i++) {
    freqs[i] = freqs[i - 1] * freqDelta;
  }
  return freqs;
}
