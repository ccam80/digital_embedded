/**
 * MNAEngine- the concrete AnalogEngine implementation.
 *
 * Orchestrates SparseSolver, cktLoad, TimestepController, HistoryStore,
 * DiagnosticCollector, and the DC / transient solver functions into a working
 * analog simulator behind the AnalogEngine interface.
 */

import type { CompiledCircuit, EngineChangeListener, MeasurementObserver } from "../../core/engine-interface.js";
import { EngineState } from "../../core/engine-interface.js";
import type {
  AnalogEngine,
  DcOpResult,
  SimulationParams,
  TfParams,
  TfResult,
} from "../../core/analog-engine-interface.js";
import type { IntegrationMethod } from "./integration.js";
import type { Diagnostic } from "../../compile/types.js";
import type { SetupContext } from "./setup-context.js";
import { DEFAULT_SIMULATION_PARAMS, resolveSimulationParams, computeFirstStep } from "../../core/analog-engine-interface.js";
import type { ResolvedSimulationParams } from "../../core/analog-engine-interface.js";
import { AcAnalysis } from "./ac-analysis.js";
import type { AcParams, AcResult, AcAnalysisDeps } from "./ac-analysis.js";
import { SparseSolver } from "./sparse-solver.js";
import { TimestepController, almostEqualUlps } from "./timestep.js";
import { HistoryStore, computeNIcomCof } from "./integration.js";
import { DiagnosticCollector, makeDiagnostic } from "./diagnostics.js";
import { ConvergenceLog } from "./convergence-log.js";
import type { StepRecord, NRAttemptRecord } from "./convergence-log.js";

import { solveDcOperatingPoint, runTransferFunction, dcopFinalize } from "./dc-operating-point.js";
import type { DcOpNRPhase, DcOpNRAttemptOutcome, TfPortSpec } from "./dc-operating-point.js";
import { newtonRaphson } from "./newton-raphson.js";
import type { LimitingEvent } from "./newton-raphson.js";
import { CKTCircuitContext } from "./ckt-context.js";
import type { AnalogElement } from "./element.js";
import { isPoolBacked, isRuntimeDiagnosticAware } from "./element.js";
import { buildTopologyInfo, runPostSetupDetectors } from "./topology-diagnostics.js";
import type { ConcreteCompiledAnalogCircuit } from "./compiled-analog-circuit.js";
export type { ConcreteCompiledAnalogCircuit } from "./compiled-analog-circuit.js";
import type { StatePool } from "./state-pool.js";
import {
  MODEUIC, MODEDCOP, MODETRAN, MODETRANOP,
  MODEINITJCT, MODEINITTRAN, MODEINITPRED, MODEINITSMSIG,
} from "./ckt-mode.js";
import { cktTemp } from "./ckt-temp.js";
import { runByDeviceFamily } from "./family-dispatch.js";
import { assertPoolIsSoleMutableState } from "./state-schema.js";
import type { DeviceFamily } from "./ngspice-load-order.js";
import { AnalogCapacitorElement } from "../../components/passives/capacitor.js";
import { PropertyBag } from "../../core/properties.js";

// ---------------------------------------------------------------------------
// MNAEngine
// ---------------------------------------------------------------------------

/**
 * Concrete analog simulation engine.
 *
 * Lifecycle:
 *   new MNAEngine() → init(circuit) → dcOperatingPoint() / step() → reset() / dispose()
 *
 * The engine starts in STOPPED state. init() transitions to STOPPED (ready).
 * start() transitions to RUNNING. stop() transitions to PAUSED.
 * An unrecoverable convergence failure transitions to ERROR.
 */
export class MNAEngine implements AnalogEngine {
  // -------------------------------------------------------------------------
  // Solver infrastructure (allocated in init)
  // -------------------------------------------------------------------------
  private _solver: SparseSolver = new SparseSolver();
  private _timestep: TimestepController = new TimestepController(DEFAULT_SIMULATION_PARAMS);
  private _history: HistoryStore = new HistoryStore(0);
  private _diagnostics: DiagnosticCollector = new DiagnosticCollector();
  private _convergenceLog: ConvergenceLog = new ConvergenceLog(128);

  // -------------------------------------------------------------------------
  // CKTCircuitContext- pre-allocated god-object for NR/DC-OP hot paths
  // -------------------------------------------------------------------------
  private _ctx: CKTCircuitContext | null = null;

  // -------------------------------------------------------------------------
  // Compiled circuit reference
  // -------------------------------------------------------------------------
  private _compiled: ConcreteCompiledAnalogCircuit | null = null;

  private _elements: readonly AnalogElement[] = [];

  /**
   * Capacitor leaves injected by the `.option cshunt` pass (inppas4.c:54-75),
   * one per non-ground voltage node. Tracked so a re-init() on the same
   * compiled circuit can strip the prior pass's leaves before _setup() injects
   * a fresh set — without this, a reused ConcreteCompiledAnalogCircuit.elements
   * array would accumulate a duplicate shunt cap per node on every init().
   */
  private _cshuntLeaves: AnalogCapacitorElement[] = [];

  // -------------------------------------------------------------------------
  // Setup-phase state (A4.2)
  // -------------------------------------------------------------------------
  private _isSetup: boolean = false;
  /**
   * Mirrors ngspice dctran.c `firsttime` (line 189). Flips false → true on
   * the first step() after init/reset, gating the warm-start transient DCOP
   * (dctran.c:117-360 `if(restart || CKTtime==0)` block). Cleared by
   * init()/reset()/dispose() so a fresh transient run re-runs the DCOP.
   */
  private _firstStep: boolean = false;
  private _maxEqNum: number = 0;
  private _numStates: number = 0;
  private _nodeTable: Array<{ name: string; number: number; type: "voltage" | "current" }> = [];
  private _deviceMap: Map<string, AnalogElement> = new Map();

  /**
   * Read access to the internal-node table populated by `_makeNode` during
   * setup(). Direct analogue of ngspice `CKTnodeTab` walked by `cktnoddmp.c`.
   * Each entry pairs a `${label}#${suffix}` name with the equation number
   * returned by ctx.makeVolt / ctx.makeCur. Pin nodes (1..compiled.nodeCount)
   * are NOT in this table- they're allocated by the compiler before setup.
   */
  getNodeTable(): readonly { name: string; number: number; type: "voltage" | "current" }[] {
    return this._nodeTable;
  }

  // -------------------------------------------------------------------------
  // Engine lifecycle state
  // -------------------------------------------------------------------------
  private _engineState: EngineState = EngineState.STOPPED;
  private _changeListeners: EngineChangeListener[] = [];

  // -------------------------------------------------------------------------
  // Simulation time tracking
  // -------------------------------------------------------------------------
  // Schedule clock (ngspice `optime`): drives timestep control, breakpoints,
  // termination and history rotation. Advances on every accepted step, including
  // each OPtran pseudo-transient step.
  private _simTime: number = 0;
  private _lastDt: number = 0;
  // True only while the OPtran pseudo-transient runs. ngspice keeps two clocks:
  // the schedule clock `optime` and the circuit clock `CKTtime` (read by source
  // loads and CKTaccept). The transient advances both together; optran.c advances
  // only `optime` and leaves `CKTtime` at the operating-point time. Here
  // `this._simTime` is the schedule clock and `timeRef.value` is the circuit
  // clock; this flag stops step() advancing the circuit clock during OPtran.
  private _holdCircuitTime: boolean = false;

  // -------------------------------------------------------------------------
  // Solver configuration
  // -------------------------------------------------------------------------
  private _params: ResolvedSimulationParams = { ...DEFAULT_SIMULATION_PARAMS };

  // -------------------------------------------------------------------------
  // Engine interface- Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialise the engine with a compiled analog circuit.
   *
   * Narrows `circuit` to `ConcreteCompiledAnalogCircuit`. Allocates all
   * runtime arrays sized to `matrixSize`. Resets simulation time.
   *
   * @param circuit - Must satisfy the ConcreteCompiledAnalogCircuit shape.
   */
  init(circuit: CompiledCircuit): void {
    const compiled = circuit as ConcreteCompiledAnalogCircuit;
    this._compiled = compiled;
    // Strip any cshunt capacitor leaves a prior init()/_setup() on this same
    // compiled circuit appended to compiled.elements (inppas4.c:54-75 injects
    // a fresh leaf per voltage node every setup pass; re-running on the same
    // array would otherwise double-inject). The fresh pass re-creates them.
    if (this._cshuntLeaves.length > 0) {
      const injected = new Set<AnalogElement>(this._cshuntLeaves);
      const base = compiled.elements.filter(el => !injected.has(el));
      compiled.elements.length = 0;
      compiled.elements.push(...base);
      this._cshuntLeaves = [];
    }
    this._elements = compiled.elements;

    const { elements } = compiled;

    this._solver = new SparseSolver();
    this._history = new HistoryStore(elements.length);
    this._diagnostics = new DiagnosticCollector();
    this._convergenceLog.clear();

    // Wire the runtime-diagnostic channel into every element that opts in
    // (RuntimeDiagnosticAware). Mirrors the timeRef pattern: compile-time
    // factories cannot reference the engine's collector (it's constructed
    // here, post-compile), so the engine pushes the emit closure into each
    // element after construction. Coordinator surfaces emissions via
    // getRuntimeDiagnostics() through the existing onDiagnostic subscription.
    const emitToCollector = (d: Diagnostic): void => this._diagnostics.emit(d);
    for (const el of elements) {
      if (isRuntimeDiagnosticAware(el)) {
        el.setDiagnosticEmitter(emitToCollector);
      }
    }

    this._simTime = 0;
    this._lastDt = 0;

    // Build the device map for findDevice/findBranch dispatch (A4.1).
    this._deviceMap = new Map<string, AnalogElement>();
    this._buildDeviceMap(compiled.elements, "");

    // Reset setup-phase state so _setup() runs unconditionally on next analysis call.
    this._isSetup = false;
    this._firstStep = false;
    this._maxEqNum = compiled.nodeCount + 1;
    this._numStates = 0;
    // Seed _nodeTable with composite-internal nodes the compiler pre-allocated
    // via `expandCompositeInstance`. These IDs occupy the range
    // [externalNodeCount + 1 .. compiled.nodeCount]; element-private nodes
    // allocated at setup() time via `makeVolt` continue from `_maxEqNum`.
    this._nodeTable = compiled.preAllocatedNodes.map(e => ({
      name: e.name,
      number: e.number,
      type: e.type as "voltage" | "current",
    }));

    // Construct CKTCircuitContext for NR and DC-OP call sites.
    // Shares the same solver and elements as the rest of init().
    //
    // Order matters: the ctx constructor allocates ctx.deltaOld (length 7,
    // seeded to params.maxTimeStep). The TimestepController is then built
    // with a reference to THAT same array, so ctx.deltaOld and the
    // controller's internal CKTdeltaOld[] are identical by identity-
    // matches ngspice where CKTdeltaOld[7] lives on CKTcircuit. The
    // addBreakpoint closure captures `this._timestep` by reference, so it
    // resolves correctly after the controller is assigned below.
    this._ctx = new CKTCircuitContext(
      {
        nodeCount: compiled.nodeCount,
        elements: compiled.elements,
        elementsByFamily: compiled.elementsByFamily,
      },
      this._params,
      (t) => this._timestep.addBreakpoint(t),
      this._solver,
    );
    this._timestep = new TimestepController(this._params, this._ctx.deltaOld);
    // Wire diagnostics
    this._ctx.diagnostics = this._diagnostics;

    // Constructor seeds queue=[0, finalTime] and breakFlag=true (ngspice
    // dctran.c:140-145, 188). No explicit seed call needed.
    this._transitionState(EngineState.STOPPED);
  }

  /** Reset voltages, history, and simulation time to initial state. */
  reset(): void {
    if (this._ctx) {
      this._ctx.rhs.fill(0);
      this._ctx.rhsOld.fill(0);
    }
    this._history.reset();
    this._simTime = 0;
    this._firstStep = false;
    const cac = this._compiled as ConcreteCompiledAnalogCircuit | undefined;
    if (cac?.timeRef) cac.timeRef.value = 0;
    if (cac?.statePool) {
      cac.statePool.reset();
      for (const el of this._elements) {
        if (isPoolBacked(el)) {
          el.initState(cac.statePool);
        }
      }
    }
    this._lastDt = 0;
    // Preserve the unified CKTdeltaOld identity: reseed the SAME shared buffer
    // that ctx.deltaOld points at, rather than letting the new controller
    // self-allocate. Without this the TimestepController would allocate a
    // fresh length-7 array, breaking `ctx.deltaOld === timestep.deltaOld`
    // and forcing copy-loop drift back into the engine.
    this._timestep = new TimestepController(
      this._params,
      this._ctx ? this._ctx.deltaOld : undefined,
    );
    this._diagnostics.clear();
    this._convergenceLog.clear();
    this._stepCount = 0;
    for (const obs of this._measurementObservers) {
      obs.onReset();
    }
    // Constructor (above) seeded queue + breakFlag.
    this._transitionState(EngineState.STOPPED);
  }

  /** Release all resources. Engine must not be used after dispose(). */
  dispose(): void {
    this._compiled = null;
    this._ctx = null;
    this._history = new HistoryStore(0);
    this._diagnostics.clear();
    this._changeListeners = [];
    this._isSetup = false;
    this._firstStep = false;
  }

  /**
   * Advance one transient timestep.
   *
   * Sequence:
   *   1. Save current voltages for potential rollback.
   *   2. Stamp companion models for reactive elements at current dt.
   *   3. Run Newton-Raphson.
   *   4. On NR failure: halve dt and retry until minTimeStep, then ERROR.
   *   5. Estimate LTE and check rejection.
   *   6. On LTE rejection: restore prevVoltages, halve dt, retry.
   *   7. On acceptance: advance simTime, push history, update dt.
   */
  step(): void {
    if (!this._compiled) return;
    this._setup();
    if (this._engineState === EngineState.ERROR) return;

    // ngspice dctran.c:117-360- `if(restart || CKTtime==0)` firsttime block.
    // The transient driver runs the warm-start DCOP (CKTop with MODETRANOP|
    // MODEINITJCT) before falling through into the first nextTime: iteration.
    // We mirror that structure here: _transientDcop() is the warm-start
    // (analog-engine.ts equivalent of dctran.c:230-350), then control falls
    // through into the existing transient body (equivalent of dctran.c's
    // for(;;) loop). _firstStep gates this so subsequent step() calls skip
    // straight into transient stepping.
    if (!this._firstStep) {
      this._transientDcop();
      this._firstStep = true;
    }

    const { elements } = this._compiled;
    const params = this._params;
    const logging = this._convergenceLog.enabled;
    let stepRec: StepRecord | null = null;

    const ctx = this._ctx!;
    // ngspice does NOT copy CKTrhs into CKTrhsOld between accepted steps
    // (see dctran.c around lines 715-723: only CKTdeltaOld and CKTstates are
    // rotated; CKTrhs/CKTrhsOld are left to carry forward whatever the previous
    // NIiter call left). Newton-raphson.ts now mirrors NIiter's pointer-swap
    // exit invariant via ctx.swapRhsBuffers(), so ctx.rhsOld already holds the
    // converging iter's input- no extra copy required here.
    const statePool = (this._compiled as ConcreteCompiledAnalogCircuit).statePool ?? null;
    const cac = this._compiled as ConcreteCompiledAnalogCircuit;

    // Top-of-iteration acceptStep dispatch- mirrors ngspice CKTaccept at
    // dctran.c:410 (head of the `nextTime:` iteration body, BEFORE the
    // breakpoint clamp). CKTaccept registers source breakpoints against the
    // circuit clock (it reads CKTtime), so we pass timeRef.value- equal to the
    // schedule clock in the transient, held at the OP time during OPtran. On the
    // first call it is 0 and breakFlag=true via the constructor's CKTbreak=1
    // pre-seed (dctran.c:188), so PULSE sources hit SAMETIME(time, 0) and
    // register their first TR. On subsequent calls breakFlag carries over from
    // the previous step's getClampedDt approaching-breakpoint clamp.
    const addBPTop = ctx.addBreakpointBound;
    const breakFlagTop = this._timestep.breakFlag;
    for (const el of elements) {
      if (el.acceptStep) {
        el.acceptStep(cac.timeRef.value, addBPTop, breakFlagTop);
      }
    }

    let dt = this._timestep.getClampedDt(this._simTime);
    const method = this._timestep.currentMethod;

    if (logging) {
      stepRec = {
        stepNumber: this._stepCount,
        simTime: this._simTime,
        entryDt: dt,
        acceptedDt: dt,
        entryMethod: method,
        exitMethod: method,
        attempts: [],
        lteWorstRatio: 0,
        lteProposedDt: 0,
        lteRejected: false,
        outcome: "accepted",
      };
    }

    // ---- Single retry loop (ngspice dctran.c:715 for(;;)) ----
    // Both NR failure and LTE rejection feed back to the top.
    // Each iteration: stamp companions → NR solve → LTE check.
    let newDt = dt;
    let worstRatio = 0;
    let olddelta = dt;    // ngspice dctran.c:729- tracks previous delta for two-strike delmin
    // ngspice dctran.c:881-892- tryOrderPromotion writes CKTdelta directly via
    // line 894 (`ckt->CKTdelta = newdelta;`). Track whether tryOrderPromotion
    // ran on the accepting attempt so the post-loop currentDt assignment at
    // the bottom of step() doesn't clobber the order-2 result with the stale
    // order-1 newDt.
    let promotionAttempted = false;

    // ngspice dctran.c:704-706- rotate deltaOld BEFORE entering the loop.
    this._timestep.rotateDeltaOld();

    // ngspice dctran.c:715-723- rotate state vectors BEFORE retry loop.
    // Pointer swap: states[0] is fresh recycled storage, states[1] = previous accepted.
    // Elements read/write states[0] during NR; states[1] holds the last accepted state.
    // No post-rotation refresh needed- loadCtx.state0..state3 are live getters
    // that resolve through StatePool.states[] on every access (cktdefs.h:82-85
    // CKTstateN macro semantics).
    if (statePool) {
      statePool.rotateStateVectors();
    }

    for (;;) {
      // ngspice dctran.c:735- deltaOld[0] = delta each iteration.
      this._timestep.setDeltaOldCurrent(dt);

      // ngspice dctran.c:731- advance the schedule clock at the top of each
      // iteration.
      this._simTime += dt;

      // Advance the circuit clock (timeRef, ngspice CKTtime) in lockstep so
      // time-varying sources evaluate at the new time during the NR solve that
      // follows. OPtran advances only the schedule clock (above) and holds the
      // circuit clock at the operating-point time, exactly as optran.c steps a
      // local `optime` while leaving CKTtime untouched.
      if (!this._holdCircuitTime) cac.timeRef.value = this._simTime;

      // ngspice's NIpred predictor is undef'd in default builds
      // (ref/ngspice/visualc/include/ngspice/config.h:475 `/* #undef PREDICTOR */`,
      // doc/ngspice.texi:693-696 "enabling it is NOT considered safe"). Both
      // dctran.c:750-752 (`#ifdef PREDICTOR error = NIpred(ckt)`) and the
      // nicomcof.c:129 agp block compile out, so the previous NR iterate in
      // CKTrhsOld is the NR initial guess for every step. We mirror that:
      // no predictor, no agp, no CKTpred buffer, no NodeVoltageHistory.

      // --- Phase hook: begin attempt ---
      // Label from the cktMode INITF bit the NR call will see on iter 1,
      // mirroring ngspice-bridge.ts:78-81 (cktModeToPhase). After the
      // dctran.c:794 mirroring write below, every NR-call entry carries
      // MODEINITTRAN (step 0 + firsttime NR-fail retry) or MODEINITPRED (every
      // other case); deriving from the bit keeps both sides emitting the same
      // phase string for retry attempts.
      if (this.stepPhaseHook) {
        let attemptPhase: "tranInit" | "tranPredictor" | "tranNR";
        if (ctx.cktMode & MODEINITTRAN) {
          attemptPhase = "tranInit";
        } else if (ctx.cktMode & MODEINITPRED) {
          attemptPhase = "tranPredictor";
        } else {
          attemptPhase = "tranNR";
        }
        this.stepPhaseHook.onAttemptBegin(attemptPhase, dt);
      }

      // --- NIcomCof (ngspice dctran.c:736) ---
      // Recompute ag[] integration coefficients before each NR solve.
      // Elements read ag[] via ctx.loadCtx.ag inside their load() calls.
      if (statePool) {
        statePool.dt = dt;
        computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
          this._timestep.currentMethod, params.xmu, this._ctx!.ag, this._ctx!.gearMatScratch);
        // MODEINITTRAN is already live in ctx.cktMode from _seedFromDcop.
        // niiter's INITF dispatcher will clear it to MODEINITFLOAT after the
        // first cktLoad. No deferred write needed.
      }

      // --- NR solve (ngspice dctran.c:770 NIiter) ---
      // ctx.deltaOld and timestep.deltaOld share the same backing array
      // (wired in MNAEngine.init), so rotateDeltaOld()/setDeltaOldCurrent()
      // updates are visible here without an explicit copy loop.
      //
      // xfact (CKTdelta / CKTdeltaOld[1]) is computed function-local inside
      // each device load() that needs it under MODEINITPRED, mirroring
      // bjtload.c:279, mos1load.c, dioload.c. No engine-side write.
      // dt for reactive elements to use in load() (CKTdelta).
      ctx.loadCtx.dt = dt;
      // Synchronize integration order and method with the timestep controller
      // before NR. ngspice stores CKTorder and CKTintegrateMethod on the CKT
      // struct itself- a single source of truth read by both NIcomCof (ag[])
      // and every device load routine. Our timestep controller is a separate
      // object; without this copy, loadCtx.order/method stay at their ckt-
      // context.ts:537 init values while timestep.currentOrder/currentMethod
      // promote after LTE acceptance (tryOrderPromotion). That desync causes
      // niIntegrate to apply the order-1 formula to order-2 ag[] coefficients
      // (ag[1] = xmu/(1-xmu) = 1.0 for TRAP order 2, interpreted as -1/dt
      // under order 1), producing catastrophic companion-current errors.
      ctx.loadCtx.order = this._timestep.currentOrder;
      ctx.loadCtx.method = this._timestep.currentMethod;
      // CKTminBreak — bound once at top-of-step alongside order/method;
      // updateParams() refreshes _minBreak inside the controller. Read by
      // TRA acceptStep (traaccept.c:49 history-table grow predicate).
      ctx.loadCtx.minBreak = this._timestep.minBreak;
      ctx.maxIterations = params.transientMaxIterations;
      ctx.enableBlameTracking = logging;
      ctx.postIterationHook = this.postIterationHook;
      ctx.preFactorHook = this.preFactorHook;
      ctx.detailedConvergence = this.detailedConvergence;
      ctx.limitingCollector = this.limitingCollector;
      // Wire the transient mode ladder ONLY when a phase hook is attached
      // (harness mode). It fires on intra-NR-call INITF transitions
      // (MODEINITTRAN→FLOAT, MODEINITPRED→FLOAT) so harness attempt-grouping
      // matches the ngspice bridge's split-on-cktMode-change rule.
      //
      // Ownership of attempt boundaries:
      //   - The OUTER hook above (line 406) opens the first attempt for this
      //     NR call (tranInit / tranPredictor / tranNR), labelled from cktMode bits.
      //   - The OUTER hook below (lines 510, 534, 560, 565) closes the LAST
      //     attempt for this NR call (accepted / nrFailedRetry / lte... ).
      //   - The LADDER fires only the MIDDLE split: when the INITF dispatcher
      //     promotes MODEINITTRAN/MODEINITPRED to MODEINITFLOAT mid-NR, it
      //     ends the current attempt with "tranPhaseHandoff" and opens a
      //     fresh "tranNR" attempt. The terminal "tranNR" close from
      //     newton-raphson is intentionally a no-op here- the outer hook
      //     owns the final outcome.
      //
      // Production runs (stepPhaseHook null) leave nrModeLadder null- zero
      // overhead beyond one null-coalesce per NR call.
      const tranLadderHook = this.stepPhaseHook;
      ctx.nrModeLadder = tranLadderHook
        ? {
            onModeBegin(phase, _iter): void {
              if (phase === "tranNR") {
                tranLadderHook.onAttemptBegin("tranNR", dt);
              }
            },
            onModeEnd(phase, _iter, _converged): void {
              if (phase === "tranInit" || phase === "tranPredictor") {
                tranLadderHook.onAttemptEnd("tranPhaseHandoff", false);
              }
            },
          }
        : null;
      ctx.exactMaxIterations = false;
      ctx.onIteration0Complete = null;
      newtonRaphson(ctx);
      const nrResult = ctx.nrResult;

      // ngspice dctran.c:794- fires UNCONDITIONALLY inside the for(;;) retry
      // loop, AFTER NIiter and BEFORE the converged/non-converged branch. Sets
      // the cktMode that the NEXT NIiter call's iter-1 cktLoad will see;
      // niiter.c:1075-1076 then clears MODEINITPRED→MODEINITFLOAT after that
      // first cktLoad. Must run on every outer iteration so NR-fail retries,
      // LTE-reject retries, and the accept→next-step transition all enter their
      // next NR call with MODEINITPRED set. Device load() consumers
      // (diode.ts:522, bjt.ts:862, capacitor.ts:279, …) branch on this bit and
      // run the state1→state0 + xfact-extrapolation arm only when set.
      ctx.cktMode = (ctx.cktMode & MODEUIC) | MODETRAN | MODEINITPRED;

      // ngspice dctran.c:795-799- firsttime block fires AFTER NIiter on every
      // outer iteration (converged or not), copying state1 into state2 and
      // state3 (only those two slots; state4..state7 are not touched). Placed
      // here, inside the for(;;) loop, to match ngspice's structural location.
      // Width (state2 + state3 only) matches the dctran loop bound.
      if (this._stepCount === 0 && statePool) {
        statePool.copyState1ToState23();
      }

      // --- Logging (merged from initial and retry blocks) ---
      if (logging) {
        stepRec!.attempts.push({
          dt,
          method: this._timestep.currentMethod,
          iterations: nrResult.iterations,
          converged: nrResult.converged,
          blameElement: nrResult.largestChangeElement,
          blameNode: nrResult.largestChangeNode,
          trigger: stepRec!.attempts.length === 0 ? "initial" : "nr-retry",
        });
        if (this._convergenceLog.enabled) {
          const drainable = this.postIterationHook as unknown as { drainForLog?: () => NRAttemptRecord["iterationDetails"] };
          if (typeof drainable?.drainForLog === "function") {
            const details = drainable.drainForLog();
            if (details !== undefined) {
              stepRec!.attempts[stepRec!.attempts.length - 1].iterationDetails = details;
            }
          }
        }
      }

      if (!nrResult.converged) {
        // --- NR FAILED (ngspice dctran.c:793-810) ---
        // ngspice does NOT restore CKTrhs/CKTrhsOld on NR failure- see
        // dctran.c:806-828, which only rewinds CKTtime, shrinks CKTdelta by 8,
        // sets CKTorder = 1, and (when firsttime) restores MODEINITTRAN. The
        // retry's next NIiter call uses whatever CKTrhsOld carries forward
        // (the failed iter's last input) plus the fresh predictor pass at the
        // top of the for(;;) loop.
        this.stepPhaseHook?.onAttemptEnd("nrFailedRetry", false);
        this._simTime -= dt;                              // ngspice dctran.c:796
        dt = dt / 8;                                    // ngspice dctran.c:802
        this._timestep.currentDt = dt;
        this._timestep.currentOrder = 1;                // ngspice dctran.c:810- order, NOT method
        // dctran.c:820-822- on NR failure while firsttime, restore MODEINITTRAN
        // on CKTmode. "firsttime" in ngspice is 1 between dctran.c:189 and 864
        // (the first successful step's acceptance). We detect it as _stepCount === 0.
        if (this._stepCount === 0 && statePool) {
          ctx.cktMode = (ctx.cktMode & MODEUIC) | MODETRAN | MODEINITTRAN;
        }
        // fall through to delmin check below
      } else {
        // --- NR CONVERGED- evaluate LTE (ngspice dctran.c:830+) ---
        this._timestep.currentDt = dt;

        // ngspice dctran.c:849-866: firsttime && converged -> skip LTE, accept
        // immediately. Our firsttime proxy is _stepCount === 0: before the
        // first-step increment it is 0, and dctran.c:864 sets firsttime = 0
        // just before jumping to nextTime where STATaccepted increments.
        // Our equivalent increment is at _stepCount++ at the end of step(),
        // giving the same one-shot semantics.
        if (this._stepCount === 0) {
          this.stepPhaseHook?.onAttemptEnd("accepted", true);
          newDt = dt;
          worstRatio = 0;
          break;  // exit for(;;) -> proceed to acceptance block
        }

        const lte = this._timestep.computeNewDt(
          elements, this._history, this._simTime, dt,
        );
        newDt = lte.newDt;
        worstRatio = lte.worstRatio;

        if (logging) {
          stepRec!.lteWorstRatio = worstRatio;
          stepRec!.lteProposedDt = newDt;
        }

        // ngspice dctran.c:856-876- trial promotion from order 1 to order 2 (trapezoidal free-running).
        // Runs INSIDE LTE check, before accept/reject, matching ngspice CKTtrunc ordering.
        // Gate: only attempt when order is 1 and LTE result is >= 90% of the executed step.
        if (this._timestep.currentOrder === 1 && newDt > 0.9 * dt) {
          this._timestep.tryOrderPromotion(elements, this._history, this._simTime, dt);
          promotionAttempted = true;
        } else {
          promotionAttempted = false;
        }

        if (!this._timestep.shouldReject(worstRatio)) {
          // --- LTE ACCEPTED (ngspice dctran.c:862-912) ---
          this.stepPhaseHook?.onAttemptEnd("accepted", true);
          break;  // exit the for(;;)- proceed to acceptance block
        }

        // --- LTE REJECTED (ngspice dctran.c:917-931) ---
        // ngspice does NOT restore CKTrhs/CKTrhsOld on LTE rejection- see
        // dctran.c:935-954, which only rewinds CKTtime and sets CKTdelta to
        // newdelta. The retry uses whatever CKTrhsOld carries forward plus
        // the fresh predictor pass at the top of the for(;;) loop.
        this.stepPhaseHook?.onAttemptEnd("lteRejectedRetry", true);
        this._simTime -= dt;                            // ngspice dctran.c:920
        if (logging) stepRec!.lteRejected = true;

        dt = newDt;                                     // ngspice dctran.c:926
        this._timestep.currentDt = dt;
        // fall through to delmin check below
      }

      // --- Common delmin check (ngspice dctran.c:934-945) ---
      if (dt <= params.minTimeStep) {
        if (olddelta > params.minTimeStep) {
          // First time at delmin- allow one more try (ngspice dctran.c:936)
          dt = params.minTimeStep;
          this._timestep.currentDt = dt;
        } else {
          // Second consecutive delmin- give up (ngspice dctran.c:941-943)
          this.stepPhaseHook?.onAttemptEnd("finalFailure", false);
          this._diagnostics.emit(
            makeDiagnostic("convergence-failed", "error",
              "Timestep too small", {
                explanation: `Newton-Raphson failed after timestep reduced to minimum (${params.minTimeStep}s).`,
                involvedElements: [],
                simTime: this._simTime,
              }),
          );
          if (logging) {
            stepRec!.outcome = "error";
            stepRec!.acceptedDt = dt;
            stepRec!.exitMethod = this._timestep.currentMethod;
            this._convergenceLog.record(stepRec!);
          }
          this._transitionState(EngineState.ERROR);
          return;
        }
      }
      olddelta = dt;   // track for next iteration's two-strike check
    }
    // ---- End single retry loop ----

    // Accept the timestep- rotation already happened before the retry loop.
    // The firsttime state2/state3 = state1 copy that ngspice does at
    // dctran.c:795-799 already fired inside the for(;;) loop above (after
    // newtonRaphson returned), matching ngspice's structural placement.
    if (statePool) {
      statePool.tranStep++;
    }

    if (logging) {
      stepRec!.acceptedDt = dt;
      stepRec!.exitMethod = this._timestep.currentMethod;
      this._convergenceLog.record(stepRec!);
    }

    if (!this._holdCircuitTime) cac.timeRef.value = this._simTime;
    this._lastDt = dt;

    // Advance timestep controller state. When tryOrderPromotion ran it already
    // wrote currentDt with the order-2 trial result (timestep.ts:712/723,
    // mirroring ngspice dctran.c:894 `ckt->CKTdelta = newdelta`); overwriting
    // with the pre-promotion order-1 newDt clobbers that and forces the next
    // step to take the smaller order-1 timestep — visible in the harness as a
    // 1.354× growth instead of ngspice's 2× cap.
    if (!promotionAttempted) {
      this._timestep.currentDt = newDt;
    }
    try {
      this._timestep.markAccepted(this._simTime);
    } catch (err) {
      this._diagnostics.emit(
        makeDiagnostic("convergence-failed", "error", String(err instanceof Error ? err.message : err), {
          explanation: "TimestepController.markAccepted() invariant violated- simTime did not advance monotonically.",
          involvedElements: [],
          simTime: this._simTime,
        }),
      );
      this._transitionState(EngineState.ERROR);
      return;
    }

    // acceptStep dispatch lives at the TOP of step()- see ngspice CKTaccept
    // ordering at dctran.c:410, head of the `nextTime:` iteration body. It
    // does NOT also fire here; doing so would dispatch twice per step and
    // diverge from ngspice's once-per-iteration semantics.

    // Notify measurement observers
    this._stepCount++;
    for (const obs of this._measurementObservers) {
      obs.onStep(this._stepCount);
    }
  }

  /** Transition to RUNNING state. */
  start(): void {
    this._transitionState(EngineState.RUNNING);
  }

  /** Transition to PAUSED state. */
  stop(): void {
    this._transitionState(EngineState.PAUSED);
  }

  /** Return the current engine lifecycle state. */
  getState(): EngineState {
    return this._engineState;
  }

  /** Current integration order (1 = order-1 startup, 2 = order-2 free-running). */
  get integrationOrder(): number {
    return this._timestep.currentOrder;
  }

  /**
   * Read-only access to the engine's pre-allocated CKTCircuitContext.
   * Required by harness tests that drive the capture hook directly rather
   * than through the real NR loop. Null until init() has been called.
   */
  get cktContext(): CKTCircuitContext | null {
    return this._ctx;
  }

  /** Current timestep (seconds) used by the timestep controller. */
  get currentDt(): number {
    return this._timestep.currentDt;
  }

  /**
   * Minimum-break threshold (ngspice CKTminBreak). Used by transient drivers
   * to detect that the run has reached the final time: ngspice dctran.c (v41)
   * terminates when `CKTfinalTime - CKTtime < CKTminBreak`.
   */
  get minBreak(): number {
    return this._timestep.minBreak;
  }

  /** Active numerical integration method for the current step. */
  get integrationMethod(): IntegrationMethod {
    return this._timestep.currentMethod;
  }

  /**
   * Trapezoidal weighting factor (ngspice ckt->CKTxmu) fed to NIcomCof for
   * the order-2 trapezoidal coefficients. 0.5 is the standard trapezoidal
   * rule; 0 degenerates to backward Euler.
   */
  get integrationXmu(): number {
    return this._params.xmu;
  }

  /**
   * Read-only view of the timestep history (ngspice CKTdeltaOld).
   * Element 0 is the dt of the most recent step; index i is (i+1)-steps ago.
   * Length 7. Used by the harness to recompute integration coefficients.
   */
  get timestepDeltaOld(): readonly number[] {
    return this._timestep.deltaOld;
  }

  /**
   * The LTE-proposed next timestep (seconds) as set by the most recent accepted step.
   * After each accepted transient step, _timestep.currentDt is updated to the LTE-proposed
   * next dt before accept() is called. This is the quantity ngspice reports as nextDelta
   * in RawNgspiceOuterEvent.
   */
  getLteNextDt(): number {
    return this._timestep.currentDt;
  }

  /** Register a state-change listener. */
  addChangeListener(listener: EngineChangeListener): void {
    this._changeListeners.push(listener);
  }

  /** Remove a previously registered state-change listener. */
  removeChangeListener(listener: EngineChangeListener): void {
    const idx = this._changeListeners.indexOf(listener);
    if (idx >= 0) {
      this._changeListeners.splice(idx, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Engine interface- Measurement observers
  // -------------------------------------------------------------------------

  private _measurementObservers: MeasurementObserver[] = [];
  private _stepCount: number = 0;
  private _devProbeRan: boolean = false;
  /** Register an observer to receive step/reset notifications. */
  addMeasurementObserver(observer: MeasurementObserver): void {
    if (!this._measurementObservers.includes(observer)) {
      this._measurementObservers.push(observer);
    }
  }

  /** Remove a previously registered measurement observer. */
  removeMeasurementObserver(observer: MeasurementObserver): void {
    const idx = this._measurementObservers.indexOf(observer);
    if (idx >= 0) {
      this._measurementObservers.splice(idx, 1);
    }
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface- DC Analysis
  // -------------------------------------------------------------------------

  /**
   * Find the DC operating point of the circuit.
   *
   * Delegates to the three-level solver. Stores the resulting node
   * voltages in `ctx.rhs` so subsequent `step()` calls start from the
   * correct operating point.
   */
  /**
   * The bare CKTop convergence ladder (ngspice cktop.c): runs the DC-OP mode
   * ladder and, on success, leaves the Jacobian factored. Does NOT run the
   * MODEINITSMSIG small-signal load- that is the analysis driver's job
   * (dcOperatingPoint appends it for `.op`; AcAnalysis appends it for AC). The
   * transient boot (_transientDcop) and `.tf` (transferFunction) share this bare
   * ladder, matching ngspice DCtran / TFanal calling CKTop, not DCop.
   */
  private _runDcOpLadder(): DcOpResult {
    if (!this._compiled) {
      return {
        converged: false,
        method: "direct",
        iterations: 0,
        nodeVoltages: new Float64Array(0),
        diagnostics: [],
        reorders: 0,
        singularRetries: 0,
      };
    }

    this._diagnostics.clear();
    // niiter.c:1341-1343 — NIresetwarnmsg() zeroes the singular-matrix warning
    // counter at the head of each analysis, so DC-OP gets a fresh six-message
    // budget (niiter.c:1104-1111).
    this._ctx!.resetWarnMsg();

    const cac = this._compiled as ConcreteCompiledAnalogCircuit;

    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.preFactorHook = this.preFactorHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    // dcop.c:82- firstmode = (CKTmode & MODEUIC) | MODEDCOP | MODEINITJCT
    // Standalone .OP is MODEDCOP only (not MODETRANOP). vsrcload.c:410-411
    // scales source value by CKTsrcFact ONLY under MODETRANOP, so for
    // standalone .OP the source-load srcFact path is gated off by the
    // analysis bits. CKTsrcFact enters at 1- the source-stepping sub-solve
    // (gillespieSrc / spice3Src) mutates ctx.srcFact internally during the
    // ramp, but the ladder entry value must be 1.
    ctx.srcFact = 1;
    const uicBitDcop = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBitDcop | MODEDCOP | MODEINITJCT;
    // ngspice's dcop.c does NOT explicitly write CKTag[0] / CKTag[1]; it
    // inherits the implicit precondition that ag[0] = ag[1] = 0 at DCOP
    // entry. ngspice maintains that precondition by virtue of its analysis
    // ordering: CKTinit calloc-zeroes the struct, and the only writers of
    // CKTag are nicomcof.c (during transient steps) and dctran.c:348 /
    // dcpss.c:389 (which explicitly reset to zero at transient init). The
    // standard ngspice flow never re-enters dcop.c after a transient step,
    // so the precondition is preserved without any explicit code.
    //
    // Our public API exposes coordinator.dcOperatingPoint() as a callable
    // method that CAN run after a transient step (e.g. buildFixture's
    // warm-start does _transientDcop + first transient step before tests
    // call dcOperatingPoint() again). After that warm-start, ag[0] holds
    // the prior step's 1/dt value from nicomcof, which corrupts the next
    // DCOP because devices whose load() unconditionally stamps -k*ag[0]
    // (mutload.c:74-75 / MutualInductorElement.loadCouplingPass) inject huge non-zero
    // off-diagonals into a matrix the DC analysis assumes is ag-independent.
    //
    // Make ngspice's implicit precondition explicit at our DCOP entry,
    // mirroring the structure of dctran.c:348's `CKTag[0]=CKTag[1]=0`.
    ctx.ag[0] = 0;
    ctx.ag[1] = 0;
    // dcop.c / cktop.c never write CKTdelta either. CKTdelta is reset by
    // cktdojob.c:117 at job entry (CKTdelta=0; CKTtime=0;) — but again,
    // that's a per-job reset, not a per-analysis one. We zero loadCtx.dt
    // for the same reason as ag above: device load() reads it directly.
    // We do NOT zero the timestep controller's currentDt — that field is
    // owned by the transient flow (configure / _transientDcop). Writing 0
    // there would absorb any subsequent step(): first getClampedDt()
    // returns 0 → clamped to minTimeStep → two-strike delmin sends the
    // engine to ERROR.
    ctx.loadCtx.dt = 0;
    this._setup();
    // CKTic (cktdojob.c:217-218): seed nodeset/IC into rhs + rhsOld after
    // CKTsetup and before the CKTop NR solve, so iteration 0 starts from the
    // constrained voltage (cktic.c:31,39 dual-write).
    this._seedNodesetIcRhs();
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    // cktop.c:104- wire the OPtran pseudo-transient fall-through.
    // solveDcOperatingPoint calls this only when params.optran is set AND
    // direct NR + gmin + source stepping all failed (the optran.c:51
    // nooptran-default guard lives inside solveDcOperatingPoint).
    ctx.opTranFallback = () => this._opTran();
    solveDcOperatingPoint(ctx);
    const result = ctx.dcopResult;

    if (this._convergenceLog.enabled) {
      const drainable = this.postIterationHook as unknown as { drainForLog?: () => NRAttemptRecord["iterationDetails"] };
      if (typeof drainable?.drainForLog === "function") {
        const details = drainable.drainForLog();
        const attempt: NRAttemptRecord = {
          dt: 0,
          method: "trapezoidal",
          iterations: result.iterations,
          converged: result.converged,
          blameElement: -1,
          blameNode: -1,
          trigger: "initial",
        };
        if (details !== undefined) {
          attempt.iterationDetails = details;
        }
        const dcopRec: StepRecord = {
          stepNumber: -1,
          simTime: 0,
          entryDt: 0,
          acceptedDt: 0,
          entryMethod: "trapezoidal",
          exitMethod: "trapezoidal",
          lteWorstRatio: 0,
          lteProposedDt: 0,
          lteRejected: false,
          outcome: result.converged ? "accepted" : "error",
          attempts: [attempt],
        };
        this._convergenceLog.record(dcopRec);
      }
    }

    return result;
  }

  /**
   * Standalone `.op` DC operating point (ngspice DCop, dcop.c). Runs the bare
   * CKTop ladder (`_runDcOpLadder`, which leaves the matrix factored) and then
   * appends the MODEINITSMSIG small-signal load (dcop.c:153) that DCop performs
   * after CKTop returns. The transient boot (_transientDcop) and `.tf`
   * (transferFunction) call `_runDcOpLadder` directly and skip this finalize,
   * matching ngspice DCtran / TFanal calling CKTop, not DCop.
   */
  dcOperatingPoint(): DcOpResult {
    const result = this._runDcOpLadder();
    if (!this._compiled || !result.converged) return result;
    const ctx = this._ctx!;
    // dcop.c:153- the smsig CKTload re-stamps small-signal device quantities
    // (e.g. capacitor geqcb) into state0 and un-factors the matrix; `.op` does
    // not re-solve, so the lost factorization is harmless here.
    dcopFinalize(ctx);
    // dcop.c:127- `.op` leaves the circuit in MODEDCOP|MODEINITSMSIG. NO
    // transient seeding (no MODEINITTRAN, no ag[]=0, no state0->state1 copy-
    // those are dctran.c:346-350, exclusive to _transientDcop). Write rhs from
    // the DCOP solution and refresh element-side voltage caches.
    ctx.rhs.set(result.nodeVoltages);
    for (const el of this._compiled.elements) {
      const initVoltages = (el as { initVoltages?: (rhs: Float64Array) => void }).initVoltages;
      if (typeof initVoltages === "function") {
        initVoltages.call(el, ctx.rhs);
      }
    }
    const uic = ctx.cktMode & MODEUIC;
    ctx.cktMode = uic | MODEDCOP | MODEINITSMSIG;
    return result;
  }

  /**
   * Find the DC operating point for transient analysis initialisation.
   *
   * Called by the transient solver before the first timestep to establish
   * initial conditions. Uses MODETRANOP flag to distinguish this run
   * from a standalone dcOperatingPoint() call.
   *
   * Matches ngspice dctran.c:346-350 where CKTmode is set to
   * MODETRANOP|MODEINITJCT before calling CKTop().
   *
   * @returns DcOpResult- same shape as dcOperatingPoint()
   */
  private _transientDcop(): DcOpResult {
    if (!this._compiled) {
      return {
        converged: false,
        method: "direct",
        iterations: 0,
        nodeVoltages: new Float64Array(0),
        diagnostics: [],
        reorders: 0,
        singularRetries: 0,
      };
    }

    const { elements } = this._compiled;
    this._diagnostics.clear();
    // niiter.c:1341-1343 — NIresetwarnmsg() zeroes the singular-matrix warning
    // counter at the head of the transient-boot DC-OP analysis.
    this._ctx!.resetWarnMsg();

    const cac = this._compiled as ConcreteCompiledAnalogCircuit;

    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.preFactorHook = this.preFactorHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    // dctran.c:190,231- save_mode = (CKTmode & MODEUIC) | MODETRANOP | MODEINITJCT
    // Preserve UIC; replace analysis and INITF bits entirely. Reset to the
    // first-transient-step mode inside _seedFromDcop after DCOP converges.
    // srcFact always enters at 1; dctran.c does not read srcFact at transient-
    // boot DCOP entry (cktop.c:385 sets CKTsrcFact=0 inside gillespie sub-solve).
    ctx.srcFact = 1;
    const uicBitTransDcop = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBitTransDcop | MODETRANOP | MODEINITJCT;
    // cktdojob.c:117- CKTdelta is zeroed by the job dispatcher at job entry.
    // dctran.c writes CKTdelta=delta only at line 319, AFTER CKTop returns,
    // so during the warm-start DCOP iterations CKTdelta is still 0. Mirror
    // on both the timestep controller (consumer-visible currentDt) and
    // loadCtx.dt (per-iter capture and device load() reads).
    this._timestep.currentDt = 0;
    ctx.loadCtx.dt = 0;
    // ngspice CKTstep / CKTfinalTime — bind the circuit-global transient
    // constants from the resolved params at transient boot. Independent-source
    // waveform order-guard defaults read these (vsrcload.c PULSE/SINE/EXP/SFFM/AM
    // fall back to CKTstep / CKTfinalTime when a coefficient is absent or zero).
    ctx.loadCtx.cktStep = this._params.outputStep ?? 0;
    ctx.loadCtx.cktFinalTime = this._params.tStop ?? 0;
    // CKTic (cktdojob.c:217-218 dispatches it once before the transient-boot
    // CKTop). Seeds nodeset/IC voltages and, under UIC, the per-device initial
    // conditions, so the boot DCOP at solveDcOperatingPoint() below starts from
    // the constrained state.
    this._cktic(elements);
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    // cktop.c:104- OPtran fall-through, also reachable from the transient-boot
    // DC-OP (CKTop runs the same fallback stack regardless of MODEDCOP vs
    // MODETRANOP). Gated on params.optran inside solveDcOperatingPoint.
    ctx.opTranFallback = () => this._opTran();
    solveDcOperatingPoint(ctx);
    const result = ctx.dcopResult;

    if (result.converged) {
      this._seedFromDcop(result, elements, cac);
      // dctran.c:319- CKTdelta = delta (the local first-step value computed
      // at dctran.c:118 as MIN(CKTfinalTime/100, CKTstep)/10). The harness
      // passes this value as `firstStep` via configure(); writing it here
      // mirrors ngspice's post-CKTop restoration so the first transient
      // step's getClampedDt() firsttime branch (timestep.ts:416-434) divides
      // a non-zero firstStep by 10 (matching dctran.c:580) instead of
      // dividing 0 and floor-clamping to 2*minTimeStep.
      this._timestep.currentDt = this._params.firstStep;
    }

    return result;
  }

  /**
   * OPtran operating-point pseudo-transient fallback (ngspice optran.c:284-845).
   *
   * Invoked from solveDcOperatingPoint via ctx.opTranFallback ONLY after direct
   * NR + gmin stepping + source stepping all fail AND params.optran is set
   * (cktop.c:101-108). Runs a transient simulation from time 0 to opfinaltime
   * with no output capture; the settled matrix is the operating point
   * (optran.c:286-287). It REUSES the transient stepping kernel- this method
   * configures the pseudo-transient window then drives the existing step()
   * loop, exactly as optran.c reuses dctran.c's NIiter / CKTtrunc / state
   * rotation / NIcomCof / breakpoint handling rather than re-porting numerics.
   *
   * Mapping (optran.c -> here):
   *   nooptran (optran.c:51,314-315)             -> caller's params.optran gate
   *   CKTmaxStep = CKTstep = opstepsize (:357)    -> opParams maxTimeStep/outputStep
   *   delta = MIN(opfinaltime/100, step)/10 (:359)-> computeFirstStep -> firstStep seed
   *   opbreaks = [0, opfinaltime] (:378-382)      -> controller seed queue
   *   CKTorder = 1 (:399)                         -> controller currentOrder
   *   CKTdeltaOld[i] = CKTmaxStep (:400-402)      -> controller deltaOld reseed
   *   CKTmode = (mode&MODEUIC)|MODETRAN|MODEINITTRAN (:409) -> ctx.cktMode seed
   *   ag[0]=ag[1]=0 (:411)                        -> ctx.ag reset
   *   state1 = state0 (:412-413)                  -> statePool.states[1] copy
   *   supply ramp 0.5*(1-cos(pi*t/opramptime)) (:662-664) -> step()'s srcFact (below)
   *   MODEINITTRAN re-arm on firsttime nrFail (:731) -> step() :554-556 already does this
   *   firsttime LTE-skip (:754-759)               -> step() _stepCount===0 branch
   *   CKTdelta<=CKTdelmin -> E_TIMESTEP (:807-814) -> step()'s two-strike delmin -> ERROR
   *   finish at AlmostEqualUlps(optime,opfinaltime) (:476-482) -> loop terminate test
   *
   * Returns true when the pseudo-transient reaches opfinaltime (OP settled),
   * false on timestep-too-small (E_TIMESTEP) or any step() ERROR.
   */
  private _opTran(): boolean {
    if (!this._compiled) return false;
    const ctx = this._ctx!;
    const statePool = (this._compiled as ConcreteCompiledAnalogCircuit).statePool ?? null;

    // optran.c runs its NIiter with CKTdiagGmin as CKTop left it. gillespie_src's
    // exit unconditionally sets CKTdiagGmin = CKTgmin = gminstart (cktop.c:647),
    // and the opramptime==0 path never resets it (the optran.c:333-345 reset block
    // is gated on opramptime>0). So the pseudo-transient solves with the device
    // gmin on the node diagonals- on a DC branch-current singularity that scales
    // the source-pinned nodes by (1 - gmin). ctx.refreshTolerances below reloads
    // diagonalGmin from params.diagGmin (unset -> 0), so capture the inherited
    // value now and restore it after.
    const inheritedDiagGmin = ctx.diagonalGmin;

    // optran.c:326-338- opramptime>0 init: zero CKTrhsOld + CKTstate0 and solve
    // with all sources at zero (CKTsrcFact=0) before the ramp begins. For the
    // common opramptime==0 path this block is skipped and sources run at full
    // value, so the OPtran integrates the actual circuit toward its OP.
    const opStep = this._params.opstepsize ?? 1e-8;
    const opFinal = this._params.opfinaltime ?? 1e-6;
    const opRamp = this._params.opramptime ?? 0;
    if (opRamp > 0) {
      ctx.rhsOld.fill(0);
      if (statePool) statePool.states[0].fill(0);
      ctx.srcFact = 0;
      // optran.c:337 NIiter(ckt, CKTdcTrcvMaxIter) with sources at zero. Reuse
      // the existing NR primitive- diagonalGmin/srcFact already set above.
      ctx.maxIterations = this._params.dcTrcvMaxIter;
      ctx.exactMaxIterations = false;
      ctx.noncon = 1;
      newtonRaphson(ctx);
    }

    // optran.c:355-359- CKTmaxStep = CKTstep = opstepsize; delta = MIN(
    // opfinaltime/100, CKTstep)/10. Build a resolved param set for the
    // pseudo-transient window: maxTimeStep=opstepsize (drives CKTdelmin =
    // 1e-11*opstepsize and minTimeStep), outputStep=opstepsize (CKTstep),
    // tStop=opfinaltime (CKTfinalTime), firstStep=delta (the :359 seed).
    const savedParams = this._params;
    const savedTimestep = this._timestep;
    const savedSimTime = this._simTime;
    const savedFirstStep = this._firstStep;
    const savedStepCount = this._stepCount;
    const savedCktMode = ctx.cktMode;
    const savedHoldCircuitTime = this._holdCircuitTime;

    const delta = computeFirstStep(opFinal, opStep);
    const opParams: ResolvedSimulationParams = resolveSimulationParams({
      ...savedParams,
      maxTimeStep: opStep,
      outputStep: opStep,
      tStop: opFinal,
      initTime: 0,
      firstStep: delta,
      // Hold optran disabled inside the pseudo-transient so the warm-start
      // DC-OP that step()'s body never re-enters cannot recurse OPtran. The
      // gate below (ctx.opTranFallback = null) is the real guard; this keeps
      // the resolved params self-consistent.
      optran: false,
    });
    this._params = opParams;

    // optran.c:378-382,399-403- breakpoints [0, opfinaltime], CKTorder=1,
    // CKTdeltaOld[i]=CKTmaxStep, CKTdelta=delta. A fresh controller sharing
    // ctx.deltaOld reseeds all of these (constructor: queue=[0,finalTime],
    // currentOrder=1, deltaOld[i]=maxTimeStep, currentDt=firstStep).
    this._timestep = new TimestepController(opParams, ctx.deltaOld);
    ctx.refreshTolerances(opParams);
    // Restore the gmin CKTop left on the diagonal (cktop.c:647); refreshTolerances
    // just reset it to params.diagGmin (unset -> 0). optran.c's NIiter inherits it.
    ctx.diagonalGmin = inheritedDiagGmin;

    // optran.c:409,411- CKTmode = (mode & MODEUIC) | MODETRAN | MODEINITTRAN;
    // CKTag[0]=CKTag[1]=0. The OPtran pass starts in transient mode with the
    // first-NR-call init bit set. Source loads see MODETRAN (not MODETRANOP),
    // so vsrcload.c's srcFact scaling is gated the same way a normal .tran
    // step is- full value unless opramptime drives the ramp below.
    const uic = savedCktMode & MODEUIC;
    ctx.cktMode = uic | MODETRAN | MODEINITTRAN;
    ctx.loadCtx.cktMode = ctx.cktMode;
    ctx.ag[0] = 0;
    ctx.ag[1] = 0;

    // optran.c:412-413- memcpy(CKTstate1, CKTstate0): the OPtran pass treats
    // the failed-static-solve state0 as the "last accepted" state1 so the
    // first integration step has a consistent history slot.
    if (statePool) {
      statePool.states[1].set(statePool.states[0]);
    }

    // Run the pseudo-transient from optime=0. _firstStep=true skips step()'s
    // warm-start DCOP (we are the OP solver); _stepCount=0 makes step()'s
    // firsttime branch fire (LTE-skip + MODEINITTRAN re-arm), matching
    // optran.c's firsttime semantics.
    this._simTime = 0;
    this._firstStep = true;
    this._stepCount = 0;
    // optran.c keeps ckt->CKTtime at its pre-CKTop value of 0 (dctran.c:186) for
    // the whole pseudo-transient- only the local `optime` advances. Set the
    // circuit clock to the OP time and hold it: step() advances the schedule
    // clock (_simTime) while time-varying sources (SIN/PULSE/etc.) stay at their
    // DC value. Without the hold they ramp along the pseudo-transient and the
    // settled state carries spurious reactive energy (e.g. inductor flux) into
    // the OP.
    if (this._compiled?.timeRef) this._compiled.timeRef.value = 0;
    this._holdCircuitTime = true;

    // optran.c:662-664- supply ramp. step() advances simTime then runs NR; we
    // need CKTsrcFact set BEFORE each NR call to optime (= post-advance time).
    // step() has no ramp hook, so drive the ramp via the per-step srcFact
    // refresh below: opramptime>0 sets srcFact each iteration from simTime.
    // When opramptime==0, srcFact stays 1 (sources at full value).
    if (opRamp <= 0) {
      ctx.srcFact = 1;
    }

    // Disarm the fallback so the warm-start DC-OP that nothing re-runs here
    // cannot recurse into OPtran (defence-in-depth alongside optran:false).
    const savedFallback = ctx.opTranFallback;
    ctx.opTranFallback = null;

    let converged = false;
    // optran.c:424-843- the nextTime:/resume: timestep loop. step() is one
    // iteration of dctran's for(;;); call it until optime reaches opfinaltime
    // (optran.c:476 AlmostEqualUlps(optime, opfinaltime, 100)) or step() drops
    // to ERROR (optran.c:807-814 timestep-too-small -> E_TIMESTEP).
    const maxOpSteps = 100000;
    for (let i = 0; i < maxOpSteps; i++) {
      if (opRamp > 0) {
        // optran.c:660-664- optime advances by CKTdelta inside the inner solve
        // loop; srcFact is recomputed from that advanced optime. step()
        // advances simTime at its top, so the value step() will integrate at
        // is simTime + dt. Set srcFact from the projected post-advance time.
        const projected = this._simTime + this._timestep.currentDt;
        const ot = projected >= opFinal ? opFinal : projected;
        ctx.srcFact = 0.5 * (1 - Math.cos(Math.PI * ot / opRamp));
      }
      this.step();
      if (this._engineState === EngineState.ERROR) {
        converged = false;
        break;
      }
      // optran.c:476-482- finished when optime ~= opfinaltime (100-ULP window).
      if (almostEqualUlps(this._simTime, opFinal, 100) || this._simTime >= opFinal) {
        converged = true;
        break;
      }
    }

    // optran.c:479-481- restore CKTmaxStep/CKTstep to their pre-OPtran values.
    // We restore the entire transient config the OPtran window overrode, and
    // leave the settled solution in ctx.rhs (the OP). srcFact returns to 1
    // (optran.c leaves CKTsrcFact at the ramp endpoint = 1 when ramptime>0).
    ctx.srcFact = 1;
    this._params = savedParams;
    this._timestep = savedTimestep;
    ctx.refreshTolerances(savedParams);
    // ngspice dctran.c never resets CKTdiagGmin after CKTop, so the diagonal
    // gmin gillespie_src parked on entry to OPtran (cktop.c:647, CKTgmin) carries
    // unchanged into the transient solve. refreshTolerances just reset it to
    // params.diagGmin; restore the inherited value so the main transient runs
    // with the same diagonal gmin ngspice uses on a gillespie/OPtran-assisted OP.
    ctx.diagonalGmin = inheritedDiagGmin;
    this._simTime = savedSimTime;
    this._firstStep = savedFirstStep;
    this._stepCount = savedStepCount;
    this._holdCircuitTime = savedHoldCircuitTime;
    ctx.opTranFallback = savedFallback;
    if (this._compiled?.timeRef) this._compiled.timeRef.value = savedSimTime;
    // The OPtran pass left the matrix at the OP; the caller's cktMode for the
    // post-CKTop finalize is restored to the DC-OP analysis bits it owned.
    ctx.cktMode = savedCktMode;
    ctx.loadCtx.cktMode = ctx.cktMode;

    // step() drops to ERROR on timestep-too-small; clear it so the engine is
    // usable again (the caller decides converged/failed from our return).
    if (this._engineState === EngineState.ERROR) {
      this._transitionState(EngineState.STOPPED);
    }

    return converged;
  }

  /**
   * Run an AC small-signal frequency sweep analysis.
   *
   * Creates an `AcAnalysis` instance using the engine's compiled circuit,
   * runs the sweep with the given params, and returns the `AcResult`.
   * The engine must be initialised before calling this method.
   */
  acAnalysis(params: AcParams, deps?: AcAnalysisDeps): AcResult {
    if (!this._compiled) {
      const emptyFreqs = new Float64Array(0);
      const empty = new Map<string, Float64Array>();
      for (const label of params.outputNodes) {
        empty.set(label, new Float64Array(0));
      }
      return {
        frequencies: emptyFreqs,
        magnitude: empty,
        phase: new Map(params.outputNodes.map((l) => [l, new Float64Array(0)])),
        real: new Map(params.outputNodes.map((l) => [l, new Float64Array(0)])),
        imag: new Map(params.outputNodes.map((l) => [l, new Float64Array(0)])),
        diagnostics: [],
      };
    }

    this._setup();
    // niiter.c:1341-1343 — NIresetwarnmsg() zeroes the singular-matrix warning
    // counter at the head of the AC analysis (the DC-OP that precedes the sweep
    // and any per-frequency singular-matrix warning share the six-message
    // budget for this analysis).
    this._ctx!.resetWarnMsg();
    // Adapt the compiled circuit to AcCompiledCircuit, supplying matrixSize
    // from the post-setup solver (mirrors ngspice CKTmaxEqNum + 1).
    const adapted = {
      nodeCount: this._compiled.nodeCount,
      matrixSize: this._solver.matrixSize,
      elements: this._compiled.elements,
      elementsByFamily: this._compiled.elementsByFamily,
      labelToNodeId: this._compiled.labelToNodeId,
    };
    // Hand AcAnalysis the engine's setup-allocated solver so the AC sweep
    // reuses the one TSTALLOC'd matrix structure (ngspice CKTsetup reused by
    // DC and AC). Every element's setup()-cached matrix handles then address
    // the right cells in complex mode. A caller-supplied solverFactory (e.g.
    // a test injecting its own solver) takes precedence.
    const ac = new AcAnalysis(adapted, this._params, {
      ...deps,
      solverFactory: deps?.solverFactory ?? (() => this._solver),
      // ngspice runs CKTop + CKTacLoad on one ckt over the one TSTALLOC'd
      // matrix (CKTsetup). Hand AcAnalysis the engine's setup-allocated context
      // so the DC-OP that precedes the sweep stamps through each element's
      // setup()-cached handles into this solver- leaving finite gm/gds/cap
      // operating-point state in the element slots the per-frequency acLoad
      // reads. A separate fresh context would have no handles and mis-stamp
      // every nonlinear device (all-NaN AC solution).
      cktContext: deps?.cktContext ?? this._ctx!,
    });
    return ac.run(params);
  }

  /**
   * Re-solve the post-DC-OP factored Jacobian with a caller-supplied RHS.
   *
   * Generic primitive (Ratification R-1): performs one forward/back-substitution
   * against the existing LU with NO re-factor, writing the solution back into
   * `rhs` in place. Maps to ngspice `SMPsolve(matrix, CKTrhs, CKTrhsSpare)`
   * (tfanal.c:87, 150) — the spare buffer (`ctx.rhsSpare`) is the `SMPsolve`
   * scratch `CKTrhsSpare` argument, and the solution is copied back so the
   * caller reads it from the same `rhs` buffer it injected into. The DC-OP that
   * left the matrix factored is the caller's responsibility (the sparse solver
   * asserts IS_FACTORED, sparse-solver.ts:790-794). `.tf` consumes this; a
   * future `.sens` shares it.
   */
  reSolveFactored(rhs: Float64Array): Float64Array {
    const ctx = this._ctx!;
    const spare = ctx.rhsSpare;
    ctx.solver.solve(rhs, spare);
    rhs.set(spare);
    return rhs;
  }

  /**
   * Run a DC small-signal transfer-function analysis (ngspice `.tf`, tfanal.c
   * TFanal). Resolves the input source and output port from caller labels,
   * solves the DC operating point (leaving the Jacobian factored, tfanal.c:44),
   * then runs the two-re-solve driver (`runTransferFunction`) over that factored
   * matrix.
   */
  transferFunction(params: TfParams): TfResult {
    const fail = (message: string, converged: boolean, diags: Diagnostic[]): TfResult => ({
      transferFunction: 0,
      inputResistance: 0,
      outputResistance: 0,
      inputSource: params.inputSource,
      output: params.output,
      converged,
      diagnostics: [
        ...diags,
        makeDiagnostic("dc-op-failed", "error", message, { explanation: message }),
      ],
    });

    if (!this._compiled) {
      return fail("Transfer-function analysis requires a compiled circuit.", false, []);
    }

    this._setup();

    // tfanal.c:49-71 — resolve the input source and classify it as a voltage
    // source (branch-current row, tfanal.c:82-83) or a current source (its two
    // terminal nodes, tfanal.c:79-80). CKTfndDev maps to the engine device map;
    // the source class is the element's deviceFamily.
    const inEl = this._deviceMap.get(params.inputSource);
    if (!inEl) {
      return fail(`Transfer function source "${params.inputSource}" not in circuit.`, false, []);
    }
    let input: TfPortSpec["input"];
    if (inEl.deviceFamily === "VSRC") {
      // CKTfndBranch(TFinSrc) (tfanal.c:82) — the source branch-current row.
      if (inEl.branchIndex < 0) {
        return fail(`Transfer function source "${params.inputSource}" has no branch row.`, false, []);
      }
      input = { kind: "vsource", branch: inEl.branchIndex };
    } else if (inEl.deviceFamily === "ISRC") {
      // GENnode(ptr)[0]/[1] (tfanal.c:79-80) — the source pos/neg terminals.
      const nodePos = inEl.pinNodes.get("pos");
      const nodeNeg = inEl.pinNodes.get("neg");
      if (nodePos === undefined || nodeNeg === undefined) {
        return fail(`Transfer function source "${params.inputSource}" has no pos/neg terminals.`, false, []);
      }
      input = { kind: "isource", nodePos, nodeNeg };
    } else {
      return fail(`Transfer function source "${params.inputSource}" is not of proper type (must be a voltage or current source).`, false, []);
    }

    // Resolve the output port. A current output is written "I(<sourceLabel>)"
    // (tfanal.c:97,116 — CKTfndBranch(TFoutSrc)); anything else is a node-pair
    // voltage "Vnode" or "Vpos,Vneg" (tfanal.c:113-114, TFoutPos/Neg->number).
    const out = params.output.trim();
    const currentMatch = /^I\(\s*([^)]+?)\s*\)$/i.exec(out);
    let output: TfPortSpec["output"];
    if (currentMatch) {
      const outSrcLabel = currentMatch[1]!;
      const outEl = this._deviceMap.get(outSrcLabel);
      if (!outEl) {
        return fail(`Transfer function output source "${outSrcLabel}" not in circuit.`, false, []);
      }
      if (outEl.deviceFamily !== "VSRC") {
        return fail(`Transfer function output source "${outSrcLabel}" must be a voltage source for a current output.`, false, []);
      }
      if (outEl.branchIndex < 0) {
        return fail(`Transfer function output source "${outSrcLabel}" has no branch row.`, false, []);
      }
      // tfanal.c:132-134 — TFoutIsI && (TFoutSrc == TFinSrc) shortcut.
      const sameSourceAsInput =
        input.kind === "vsource" && outSrcLabel === params.inputSource;
      output = { kind: "branch", branch: outEl.branchIndex, sameSourceAsInput };
    } else {
      const labelToNodeId = this._compiled.labelToNodeId;
      const resolveNode = (name: string): number | undefined => {
        const n = name.trim();
        if (n === "" || n === "0" || n.toLowerCase() === "gnd" || n.toLowerCase() === "ground") {
          return 0;
        }
        return labelToNodeId.get(n);
      };
      // "Vpos,Vneg" — the second name defaults to ground (node 0) when omitted.
      const commaIdx = out.indexOf(",");
      const posName = commaIdx >= 0 ? out.slice(0, commaIdx) : out;
      const negName = commaIdx >= 0 ? out.slice(commaIdx + 1) : "0";
      const nodePos = resolveNode(posName);
      const nodeNeg = resolveNode(negName);
      if (nodePos === undefined) {
        return fail(`Transfer function output node "${posName.trim()}" not found.`, false, []);
      }
      if (nodeNeg === undefined) {
        return fail(`Transfer function output node "${negName.trim()}" not found.`, false, []);
      }
      output = { kind: "node", nodePos, nodeNeg };
    }

    // tfanal.c:44 — CKTop operating point via the bare ladder, which leaves the
    // Jacobian factored on success. NOT dcOperatingPoint(): that appends the
    // `.op` smsig CKTload (dcop.c:153) which would un-factor the matrix before
    // the re-solves below. TFanal calls CKTop, not DCop.
    const dcop = this._runDcOpLadder();
    if (!dcop.converged) {
      return fail("Transfer-function analysis requires a converged DC operating point.", false, dcop.diagnostics);
    }

    const ctx = this._ctx!;
    const size = ctx.solver.matrixSize;
    const r = runTransferFunction(size, ctx.rhs, (rhs) => this.reSolveFactored(rhs), { input, output });

    return {
      transferFunction: r.transferFunction,
      inputResistance: r.inputResistance,
      outputResistance: r.outputResistance,
      inputSource: params.inputSource,
      output: params.output,
      converged: true,
      diagnostics: dcop.diagnostics,
    };
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface- Simulation time
  // -------------------------------------------------------------------------

  /**
   * Number of active MNA equations (nodes + branches), excluding the
   * ground-sentinel row/col. Returns 0 before init+setup runs. This is the
   * sparse solver's raw `_size`, NOT the ngspice-style `CKTmaxEqNum + 1`
   * metric. ngspice's public matrixSize is N + 2 (a CKTmaxEqNum counter that
   * starts at 1 for the ground sentinel and is post-incremented past the
   * last allocation); the per-iter snapshot convention in `capture.ts:407`
   * (`rhs.length + 1`) also resolves to N + 2. The harness's
   * `ngspice-bridge._parseTopology` subtracts 2 from the raw value so that
   * topology-level matrixSize fields on both sides carry this same raw N.
   */
  get matrixSize(): number {
    return this._solver.matrixSize;
  }

  /** Current simulation time in seconds. */
  get simTime(): number {
    return this._simTime;
  }

  /** Restore simulation time (used by hot-recompile). */
  setSimTime(t: number): void {
    this._simTime = t;
    const cac = this._compiled as ConcreteCompiledAnalogCircuit | undefined;
    if (cac?.timeRef) cac.timeRef.value = t;
  }

  /** Last accepted timestep in seconds. */
  get lastDt(): number {
    return this._lastDt;
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface- State access
  // -------------------------------------------------------------------------

  /**
   * Return the voltage at MNA node `nodeId` (referenced to ground).
   *
   * Node 0 is ground (always 0 V). Nodes 1..nodeCount are non-ground
   * voltages stored at solver indices 1..nodeCount (ngspice 1-based).
   */
  getNodeVoltage(nodeId: number): number {
    if (nodeId <= 0 || !this._ctx) return 0;
    if (nodeId >= this._ctx.rhs.length) return 0;
    return this._ctx.rhs[nodeId];
  }

  setNodeVoltage(nodeId: number, voltage: number): void {
    if (nodeId <= 0 || !this._ctx) return;
    if (nodeId >= this._ctx.rhs.length) return;
    this._ctx.rhs[nodeId] = voltage;
    this._ctx.rhsOld[nodeId] = voltage;
  }

  /**
   * Return the current through MNA branch row `branchId`.
   *
   * Branch rows are stored after node voltages in the solution vector,
   * starting at slot `nodeCount + 1` in the 1-based layout. `branchId`
   * is 0-based within the branch block.
   */
  getBranchCurrent(branchId: number): number {
    if (!this._compiled || !this._ctx) return 0;
    const offset = this._compiled.nodeCount + 1 + branchId;
    if (offset < 0 || offset >= this._ctx.rhs.length) return 0;
    return this._ctx.rhs[offset];
  }

  /**
   * Return the instantaneous current through analog element `elementId`.
   *
   * Returns the first pin current from getPinCurrents, which is the
   * conventional current flowing into the element at its first pin.
   */
  getElementCurrent(elementId: number): number {
    const el = this._compiled?.elements[elementId];
    if (!el || !this._ctx) return 0;
    return el.getPinCurrents(this._ctx.rhs)[0];
  }

  /**
   * Return per-pin currents for analog element `elementId`.
   */
  getElementPinCurrents(elementId: number): number[] {
    const el = this._compiled?.elements[elementId];
    if (!el || !this._ctx) return [];
    return el.getPinCurrents(this._ctx.rhs);
  }

  /**
   * Return the instantaneous power dissipated by analog element `elementId`.
   *
   * Computed as sum(V_pin_i × I_into_i) across all pins.
   */
  getElementPower(elementId: number): number {
    const el = this._compiled?.elements[elementId];
    if (!el || !this._ctx) return 0;
    const currents = el.getPinCurrents(this._ctx.rhs);
    let power = 0;
    let i = 0;
    for (const nodeId of el.pinNodes.values()) {
      if (i >= currents.length) break;
      power += this.getNodeVoltage(nodeId) * currents[i];
      i++;
    }
    return power;
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface- Configuration
  // -------------------------------------------------------------------------

  /**
   * Update solver parameters. Merges partial set into active SimulationParams.
   * Rebuilds the timestep controller so new bounds take effect immediately.
   */
  configure(params: Partial<SimulationParams>): void {
    // ngspice-parity: when the caller changes any transient input
    // (tStop / outputStep / initTime / maxTimeStep), the resolved
    // minTimeStep and firstStep would survive the spread and short-circuit
    // resolveSimulationParams's auto-derivation. ngspice has no user-override
    // path for CKTdelmin (= 1e-11 * CKTmaxStep, traninit.c:34) or the
    // dctran.c:118 firstStep formula- both are always recomputed from the
    // current transient inputs. Strip the derived bundle from the baseline
    // before merging so resolution re-fires; if the caller explicitly passes
    // minTimeStep or firstStep in `params`, the spread re-adds them.
    //
    // maxTimeStep is preserved when the caller provides it (it has a true
    // user-override path in ngspice via the .tran tmax argument); when
    // omitted, it auto-derives per traninit.c:23-32.
    //
    // If you copy this merge pattern elsewhere (parameter-sweep, monte-carlo),
    // copy the baseline-strip too.
    const baseline: SimulationParams = { ...this._params };
    // Capture the pre-merge cshunt so a structural change (a different injected
    // shunt-cap set, inppas4.c:54-75) can be detected after the merge below and
    // force a structural rebuild (the gate -1 default normalises to "off").
    const prevCshunt = this._params.cshunt ?? -1;
    const transientInputsChanged =
      "tStop" in params ||
      "outputStep" in params ||
      "initTime" in params ||
      "maxTimeStep" in params;
    if (transientInputsChanged) {
      const partial = baseline as Partial<SimulationParams>;
      if (!("maxTimeStep" in params)) delete partial.maxTimeStep;
      delete partial.minTimeStep;
      delete partial.firstStep;
    }
    this._params = resolveSimulationParams({ ...baseline, ...params });
    // Non-destructive update: preserves currentDt (clamped to new maxTimeStep),
    // _acceptedSteps, _deltaOld history, currentOrder, currentMethod, and the
    // breakpoint queue. Only tolerance / step-bound fields are refreshed.
    this._timestep.updateParams(this._params);
    // Propagate refreshed tolerances into the CKTCircuitContext- without this,
    // NR still reads the stale constructor-captured reltol/iabstol/voltTol.
    if (this._ctx) {
      this._ctx.refreshTolerances(this._params);
      // ngspice cktdefs.h:185- MODEUIC is an orthogonal mode bit preserved
      // across every analysis-mode reset (dcop.c:82, dctran.c:346, acan.c:285
      // all do `(CKTmode & MODEUIC) | …`). When `configure()` toggles
      // params.uic mid-life (the ngspice-equivalent of re-running .tran with a
      // different UIC argument), refresh the bit on the context so the next
      // _transientDcop() / step() picks it up. Without this update the
      // post-compile configure() override silently does nothing because the
      // CKTCircuitContext was constructed with the pre-configure params.
      const wantUic = (this._params.uic ?? false) ? MODEUIC : 0;
      this._ctx.cktMode = (this._ctx.cktMode & ~MODEUIC) | wantUic;
      this._ctx.loadCtx.cktMode = this._ctx.cktMode;
    }
    // ngspice cktdojob.c sets CKTfinalTime per .tran job before dctran reads it.
    // Our compile() seeds the sentinel with whatever tStop was known at compile
    // time (often undefined → Infinity for the harness path). When configure()
    // later supplies the real tStop, re-seed so the [0, finalTime] sentinel and
    // _finalTime carry the new boundary. Without this, getClampedDt's
    // approaching-breakpoint clamp compares against Infinity and the sim
    // overshoots tStop on the last step.
    if (transientInputsChanged) {
      // digiTS-specific path: tStop changed mid-run, controller is preserved
      // (currentDt, deltaOld, order, method, _stepCount). Reset queue +
      // breakFlag so the next step's acceptStep dispatch behaves as if we
      // just entered the transient loop with the new finalTime.
      const finalTime = this._params.tStop ?? Number.POSITIVE_INFINITY;
      this._timestep.restartTransientLoop(finalTime);
    }

    // CKTindverbosity is consumed inside MUTtemp (muttemp.c:58), which the DC
    // flow re-runs via CKTtemp (cktdojob.c:161-170 — CKTsetup → CKTtemp →
    // solve). When configure() changes the gate post-setup, re-run the
    // temperature pass so the inductive-system verify re-fires with the new
    // verbosity (refreshTolerances has already pushed the value into the ctx and
    // invalidated the cached TempContext above).
    if ("indVerbosity" in params && this._ctx && this._isSetup) {
      const cac = this._compiled as ConcreteCompiledAnalogCircuit | null;
      if (cac) cktTemp(this._ctx, cac.elementsByFamily);
    }

    // `.option cshunt` is a STRUCTURAL param: its value selects a set of
    // injected shunt-cap leaves (inppas4.c:54-75), built in _setup() and
    // therefore frozen once _setup() has run (_setup early-returns on
    // _isSetup). To keep cshunt hot-loadable like every other SimulationParams
    // field, a post-setup change to the active value must rebuild the circuit
    // so the next analysis re-runs _setup() and injects the new set. Both the
    // old and new values are normalised through the `> 0` gate (inp.c:466,
    // sr<=0 = off), so off->on, on->off, and on->different-on all rebuild while
    // off->off (e.g. -1 -> 0) is a no-op. init() performs the full structural
    // reset (strips the prior injected leaves, resets _maxEqNum / _numStates /
    // _nodeTable, re-wires the solver/ctx); the params just merged above are
    // preserved (init does not touch _params), so the rebuilt _setup() reads
    // the new cshunt. Mirrors the engine's "fresh structure per compile"
    // contract for the one param that changes the element set.
    if (this._isSetup && this._compiled) {
      const newCshunt = this._params.cshunt ?? -1;
      const wasActive = prevCshunt > 0;
      const nowActive = newCshunt > 0;
      const changed = wasActive !== nowActive || (nowActive && newCshunt !== prevCshunt);
      if (changed) {
        this.init(this._compiled);
      }
    }
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface- Diagnostics
  // -------------------------------------------------------------------------

  /** Register a callback to receive Diagnostic records. */
  onDiagnostic(callback: (diag: Diagnostic) => void): void {
    this._diagnostics.onDiagnostic(callback);
  }

  /** Convergence log for post-mortem analysis. Enable via convergenceLog.enabled = true. */
  get convergenceLog(): ConvergenceLog {
    return this._convergenceLog;
  }

  // -------------------------------------------------------------------------
  // Harness instrumentation accessors
  // -------------------------------------------------------------------------

  /** Expose the sparse solver for matrix/RHS snapshots. Null before init(). */
  get solver(): SparseSolver | null {
    return this._compiled ? this._solver : null;
  }

  /** Expose the shared state pool for device-state snapshots. Null before init(). */
  get statePool(): StatePool | null {
    return (this._compiled as ConcreteCompiledAnalogCircuit | undefined)?.statePool ?? null;
  }

  /** Expose the compiled element array. Empty before init(). */
  get elements(): readonly AnalogElement[] {
    return this._elements;
  }

  /** Expose the compiled circuit for topology inspection. Null before init(). */
  get compiled(): ConcreteCompiledAnalogCircuit | null {
    return this._compiled;
  }

  /**
   * Optional post-NR-iteration hook. When set, passed through to every
   * newtonRaphson() call in step() and dcOperatingPoint(). The harness
   * sets this to capture per-iteration snapshots.
   */
  postIterationHook: ((
    iteration: number,
    voltages: Float64Array,
    prevVoltages: Float64Array,
    noncon: number,
    globalConverged: boolean,
    elemConverged: boolean,
    limitingEvents: LimitingEvent[],
    convergenceFailedElements: string[],
    ctx: CKTCircuitContext,
  ) => void) | null = null;

  /**
   * Optional pre-factor hook (mirrors ngspice niiter.c:704 ni_instrument_cb).
   * Fires between cktLoad and solver.preorder()/factor(). Propagated to
   * ctx.preFactorHook before each newtonRaphson() call alongside postIterationHook.
   */
  preFactorHook: ((ctx: CKTCircuitContext) => void) | null = null;

  /** When true, NR collects all failing element indices instead of short-circuiting. */
  detailedConvergence = false;

  /** When non-null, elements push LimitingEvent objects here during NR iterations. */
  limitingCollector: LimitingEvent[] | null = null;

  /**
   * Optional phase-aware hook for harness instrumentation of step() attempts.
   * Called before each NR attempt (onAttemptBegin) and after each attempt
   * (onAttemptEnd) inside the transient retry loop.
   *
   * Also wired into dcOperatingPoint() via onPhaseBegin/onPhaseEnd, so
   * boot-step DCOP sub-solves are captured into the same session as the
   * first transient solve.
   */
  stepPhaseHook: {
    onAttemptBegin(phase: DcOpNRPhase | "tranInit" | "tranPredictor" | "tranNR", dt: number): void;
    onAttemptEnd(outcome: DcOpNRAttemptOutcome | "accepted" | "nrFailedRetry" | "lteRejectedRetry" | "finalFailure" | "tranPhaseHandoff", converged: boolean): void;
  } | null = null;

  // -------------------------------------------------------------------------
  // AnalogEngine interface- Breakpoints
  // -------------------------------------------------------------------------

  /** Register a simulation time at which the timestep must land exactly. */
  addBreakpoint(time: number): void {
    this._timestep.addBreakpoint(time);
  }

  /** Remove all registered breakpoints. */
  clearBreakpoints(): void {
    this._timestep.clearBreakpoints();
  }

  /** Read-only snapshot of diagnostics emitted by this engine's
   *  `DiagnosticCollector` since construction or last clear. */
  public getDiagnostics(): readonly Diagnostic[] {
    return this._diagnostics.getDiagnostics();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Temperature control (ngspice CKTtemp / ckttemp.c:28-33)
  // -------------------------------------------------------------------------

  /**
   * Set circuit operating temperature and re-run the per-type temperature pass.
   *
   * cite: ckttemp.c:28-33 — sets CKTtemp then calls DEVtemperature for every
   * device type. After this call, the next NR iteration sees updated
   * temperature-derived parameters for every element that implements
   * computeTemperature?(ctx).
   *
   * Invalidates the cached TempContext so the next access reconstructs it
   * from the new cktTemp value.
   */
  setCircuitTemp(K: number): void {
    const ctx = this._ctx;
    if (!ctx) return;
    // Keep cktTemp AND the load-context temp/vt in lock-step (ngspice's single
    // CKTtemp drives both DEVtemperature and DEVload's vt). Without the loadCtx
    // sync, device load() reads a stale ctx.temp while the temp pass rescales
    // tIS/tVcrit at the new temperature.
    ctx.setCircuitTempK(K);
    // ngspice stores CKTtemp as a field and runs the CKTtemp() pass after
    // CKTsetup, inside the analysis driver (ckttemp.c:28-33). Mirror that: if
    // setup() has not run, the stored temperature is applied by the temperature
    // pass at the end of _setup() on the next analysis — so computeTemperature()
    // never walks a pre-setup element (e.g. a MUT whose partner inductors are
    // resolved in setup()). Re-run the pass eagerly only when setup already ran,
    // so a post-setup temperature change takes effect immediately.
    if (!this._isSetup) return;
    const compiled = this._compiled as ConcreteCompiledAnalogCircuit | null;
    if (!compiled) return;
    cktTemp(ctx, compiled.elementsByFamily);
  }

  /**
   * Re-run the temperature pass at the current operating temperature.
   *
   * cite: ckttemp.c:28-33 — ngspice re-runs CKTtemp (calling DEVtemperature for
   * every device) before the next analysis after a `.alter`. The fold for
   * temperature/geometry/TC-derived load quantities lives solely in each
   * element's computeTemperature (CAPtemp/INDtemp ports), so re-running the pass
   * re-folds the load-read quantity (this.C / _effectiveL) from the instance
   * params a setParam hot-load just updated. Idempotent for untouched elements
   * (pure function of params + cktTemp), so a no-op for everything that did not
   * change. Mirrors setCircuitTemp's pass minus the temperature mutation.
   */
  refreshTemperatureDerivedParams(): void {
    const ctx = this._ctx;
    if (!ctx) return;
    if (!this._isSetup) return;
    const compiled = this._compiled as ConcreteCompiledAnalogCircuit | null;
    if (!compiled) return;
    cktTemp(ctx, compiled.elementsByFamily);
  }

  get circuitTemp(): number {
    return this._ctx?.cktTemp ?? 300.15;
  }

  // -------------------------------------------------------------------------
  // Setup-phase implementation (A4.2)
  // -------------------------------------------------------------------------

  /** Port of CKTsetup (cktsetup.c:30-131). Runs once per circuit
   *  lifetime. Walks elements in NGSPICE_LOAD_ORDER bucket order
   *  (matching cktsetup.c:72-81's walk of DEVices[]), calls each
   *  element's setup(ctx). Internal early-return on _isSetup
   *  mirroring cktsetup.c:52-53. After setup completes, freezes ctx's
   *  per-row buffers to the now-known solver._size. */
  private _setup(): void {
    if (this._isSetup) return;
    this._devProbeRan = false;
    const setupCtx = this._buildSetupContext();
    for (const el of this._elements) {  // already NGSPICE_LOAD_ORDER-sorted
      el.setup(setupCtx);
    }
    const cac = this._compiled as ConcreteCompiledAnalogCircuit;

    // inppas4.c:29-77 — `.option cshunt`: add a capacitor to ground from every
    // external/netlist voltage node. ngspice runs INPpas4 (spiceif.c:177) right
    // after INPpas2 (spiceif.c:168) builds ckt->CKTnodes from the netlist
    // instance lines, and BEFORE CKTsetup sizes the matrix and mints any
    // device-internal nodes. Here it runs after the per-element setup() loop
    // above and before the state/matrix/handle allocation below; the leaves
    // bind to the compiler-allocated nodes 1..nodeCount (external + composite-
    // internal), not the per-device-internal nodes the setup() loop just minted
    // into _nodeTable (those are the DEVsetup analogue, post-INPpas4 in
    // ngspice). The injected leaves are setup()-driven with the SAME setupCtx
    // (so their Norton stamps and state slots are allocated like any element)
    // and become members of the element set the matrix sizing, family dispatch,
    // and load walk all see.
    this._injectCshuntCapacitors(setupCtx, cac);

    // Single state pool ownership invariant: cac.statePool and ctx.statePool
    // must reference the same object after _setup. allocateStateBuffers adopts
    // a pre-built pool if its size matches; otherwise it allocates one and we
    // write it back here. Either way, both references converge.
    this._ctx!.allocateStateBuffers(this._numStates, cac.statePool ?? null);
    cac.statePool = this._ctx!.statePool!;
    this._ctx!.allocateRowBuffers(this._solver.matrixSize);
    // Seed ctx.ics / ctx.nodesets from the compiled circuit BEFORE the handle
    // pre-allocation below reads them. ngspice CKTic runs after the node table
    // is populated and before CKTop, allocating node->ptr = SMPmakeElt(n,n)
    // for every nsGiven / icGiven node (cktic.c:28,35). Here the compiled maps
    // are the node->icGiven/node->ic counterpart (set by the unified compiler,
    // the CKTsetNodPm analogue at cktsetnp.c:29-36). dcOperatingPoint() /
    // _transientDcop() re-point ctx.ics/ctx.nodesets at these same maps before
    // each analysis; seeding here guarantees the handles are allocated against
    // the populated maps rather than against an empty default.
    this._ctx!.ics = cac.ics ?? new Map();
    this._ctx!.nodesets = cac.nodesets ?? new Map();
    // Nodeset / IC handle pre-allocation (per A8).
    this._allocateNodesetIcHandles();

    // Build the per-slot node-type table the nodeset/IC ZeroNoncurRow walk
    // (cktload.c:167-186) consumes- the CKTnode->type counterpart. Runs after
    // the per-element setup loop (so makeCur branch entries are present in
    // _nodeTable) and after the matrix order is final (solver.matrixSize).
    this._ctx!.buildNodeTypes(this._solver.matrixSize, this._nodeTable);

    // Post-setup topology diagnostics: branchIndex is now populated.
    // Voltage-source loops, inductor loops, and competing voltage constraints
    // emit through the same DiagnosticCollector that already carries
    // convergence-failed and reactive-state-outside-pool.
    {
      // Map each branch row to the nodes it actually constrains: the KCL
      // current-injection incidence (structural entries in the branch column),
      // minus any branch-row indices (e.g. an inductor's own di/dt diagonal).
      // This lets the source/loop detectors reason about real terminals rather
      // than every pin — a controlled source's sense pins land in the branch
      // ROW (coefficients), never its column, so they are excluded.
      const branchRows = new Set(
        this._nodeTable.filter(e => e.type === "current").map(e => e.number),
      );
      const branchTerminals = new Map<number, number[]>();
      for (const el of this._elements) {
        if (el.branchIndex === -1) continue;
        branchTerminals.set(
          el.branchIndex,
          this._solver.getColumnRows(el.branchIndex).filter(r => !branchRows.has(r)),
        );
      }
      const topology = buildTopologyInfo(this._elements, branchTerminals);
      runPostSetupDetectors(topology, d => this._diagnostics.emit(d));
    }

    // Initial temperature pass — cite: ckttemp.c:28-33 (DEVtemperature called
    // once after CKTsetup completes, before the first NR iteration).
    // Runs every element's `computeTemperature?` once with cktTemp = 300.15 K
    // (REFTEMP) so temperature-dependent parameters are initialised before
    // the first NR iteration.
    cktTemp(this._ctx!, cac.elementsByFamily);

    if (import.meta.env?.DEV) {
      if (!this._devProbeRan) {
        runByDeviceFamily(
          cac.elementsByFamily,
          "load",
          this._ctx!.loadCtx,
          {
            run(_ctx: unknown, instances: readonly import("./element.js").AnalogElement[]): void {
              for (const el of instances) {
                assertPoolIsSoleMutableState(el.label, el, () => {});
              }
            },
          },
        );
        this._devProbeRan = true;
      }
    }

    this._isSetup = true;
  }

  /**
   * `.option cshunt` injection pass — port of INPpas4 (inppas4.c:29-77).
   *
   * inppas4.c:41-42 returns immediately when the option is unset; here the
   * gate is `cshunt > 0`, reproducing the inp.c:466 `sr <= 0` rejection (the
   * -1 default and any non-positive value leave the circuit untouched).
   *
   * inppas4.c:54-75 walks ckt->CKTnodes and, for every voltage node with
   * number > 0 (inppas4.c:56 — `node->type == NODE_VOLTAGE && node->number >
   * 0`), instantiates one Capacitor device to ground (csval, named
   * capac<n>shunt). Per spiceif.c:163-183, ckt->CKTnodes at INPpas4 time holds
   * only the netlist-declared (external + subcircuit-expansion) voltage nodes —
   * device-internal nodes are minted later in CKTsetup. digiTS's matching set
   * is the compiler-allocated range 1..nodeCount; iterating it ascending is
   * node-number / deck-encounter order, the same first-encounter discipline as
   * ngspice's CKTnodes walk, so the injected caps are created in ngspice's node
   * order and the per-model instance list and matrix element-pool order match.
   *
   * Every leaf is the ordinary CapacitorElement (inppas4.c:60 reuses ngspice's
   * stock Capacitor device); no new stamp or load code. The leaf is setup()-
   * driven with the same setupCtx (so its Norton stamp and state slots are
   * allocated like any element) and appended to the element set so it
   * participates in state allocation, family dispatch, matrix sizing, and the
   * load walk. Per-device-internal voltage nodes (a diode's DIOposPrime, etc.,
   * minted by the per-element setup() loop into _nodeTable with number >
   * nodeCount) get NO shunt cap — they do not exist at ngspice's INPpas4 time.
   *
   * CKTcshunt itself is set-but-unused in ngspice (cktdojob.c:74 assigns it,
   * no load path reads it), so no analogous field is carried on the context;
   * the value lives on params.cshunt and is consumed only here.
   */
  private _injectCshuntCapacitors(
    setupCtx: SetupContext,
    cac: ConcreteCompiledAnalogCircuit,
  ): void {
    // inp.c:466 / cktntask.c:90 — active only when > 0; the -1 default is off.
    const cshunt = this._params.cshunt ?? -1;
    if (!(cshunt > 0)) return;

    // inppas4.c:55 walks ckt->CKTnodes for NODE_VOLTAGE nodes with number > 0
    // (inppas4.c:56). The load-bearing phase fact (spiceif.c:163-183): INPpas4
    // (spiceif.c:177) runs immediately after INPpas2 (spiceif.c:168), which
    // builds the node table from the NETLIST instance lines only. Device-
    // internal nodes (e.g. a diode's DIOposPrime, allocated in DIOsetup) are
    // minted later, during CKTsetup — AFTER the whole INP parse returns — so
    // they are NOT in ckt->CKTnodes at INPpas4 time and get NO shunt cap.
    // ckt->CKTnodes at INPpas4 therefore holds exactly the external /
    // netlist-declared voltage nodes (including subcircuit-expansion internal
    // nodes, which INPpas2 does create).
    //
    // digiTS's matching node set is the compiler-allocated range 1..nodeCount:
    // the external net nodes plus the composite (subcircuit) internal nodes the
    // unified compiler pre-allocates via expandCompositeInstance (the INPpas2 /
    // subckt-expansion analogue) — all NODE_VOLTAGE. Per-device-internal
    // voltage nodes and branch (current) rows are minted by each element's
    // setup() (the DEVsetup / CKTsetup analogue) into _nodeTable with numbers >
    // nodeCount; those are NOT shunt-capped, matching ngspice. Iterating
    // 1..nodeCount ascending is node-number / deck-encounter order, the same
    // first-encounter discipline as ngspice's CKTnodes walk (matrix
    // element-pool parity).
    const leaves: AnalogCapacitorElement[] = [];
    for (let nodeNumber = 1; nodeNumber <= cac.nodeCount; nodeNumber++) {
      // inppas4.c:58-67 — one Capacitor device to ground, value = csval, named
      // capac<n>shunt. bindNode(1, node) ties the top node to the voltage node
      // and the 2nd node to ground (inppas4.c:62-63). The leaf's pinNodes map
      // carries that binding directly: pos -> the voltage node, neg -> ground.
      const leaf = this._makeCshuntCapacitor(`capac${nodeNumber}shunt`, nodeNumber, cshunt);
      // capsetup.c:102-117 — allocate the state base and the Norton-stamp
      // handles, the same setup() every netlisted capacitor runs.
      leaf.setup(setupCtx);
      leaves.push(leaf);
    }
    if (leaves.length === 0) return;

    this._cshuntLeaves = leaves;

    // Append the injected leaves to the shared element set so every downstream
    // _setup step (state allocation, family dispatch, matrix sizing, load walk)
    // sees them — the digiTS analogue of ngspice's INPpas4-created capacitors
    // being members of the circuit before CKTsetup runs.
    cac.elements.push(...leaves);
    this._elements = cac.elements;
    this._buildDeviceMap(leaves, "");

    // Rebuild elementsByFamily as a FRESH map so runByDeviceFamily's per-map
    // sort cache (family-dispatch.ts:36-39, keyed on the map instance) re-sorts
    // with the CAP bucket the injected leaves now belong to. Mutating the
    // existing readonly bucket arrays in place would leave the cached sorted
    // entries pointing at the stale arrays. The CAP family
    // (AnalogCapacitorElement.deviceFamily) bucket gains the leaves in node
    // order, appended after any netlisted capacitors.
    const rebuilt = new Map<DeviceFamily, AnalogElement[]>();
    for (const [family, instances] of cac.elementsByFamily) {
      rebuilt.set(family, [...instances]);
    }
    for (const leaf of leaves) {
      const bucket = rebuilt.get(leaf.deviceFamily);
      if (bucket) bucket.push(leaf);
      else rebuilt.set(leaf.deviceFamily, [leaf]);
    }
    const rebuiltReadonly: ReadonlyMap<DeviceFamily, readonly AnalogElement[]> = rebuilt;
    (cac as { elementsByFamily: ReadonlyMap<DeviceFamily, readonly AnalogElement[]> })
      .elementsByFamily = rebuiltReadonly;
    this._ctx!.elementsByFamily = rebuiltReadonly;

    // Refresh the ctx-side derived element views so the post-setup state
    // allocation and convergence walk include the injected leaves.
    // allocateStateBuffers (ckt-context.ts:977) iterates _poolBackedElements to
    // call initState on each leaf; the leaves are pool-backed capacitors, so
    // they must be in that list before the pool is sized below.
    this._ctx!.elements = cac.elements;
    (this._ctx as { _poolBackedElements: readonly AnalogElement[] })
      ._poolBackedElements = cac.elements.filter(isPoolBacked);
  }

  /**
   * Construct one cshunt Capacitor leaf (inppas4.c:58-67). The PropertyBag
   * carries `capacitance = value` marked given (the INPpName("capacitance",
   * csval) analogue, inppas4.c:67); the pinNodes map binds pos to the voltage
   * node and neg to ground slot 0 (the bindNode(1, node) / "2nd node = gnd"
   * analogue, inppas4.c:62-63).
   */
  private _makeCshuntCapacitor(
    label: string,
    nodeSlot: number,
    value: number,
  ): AnalogCapacitorElement {
    const props = new PropertyBag();
    props.setModelParam("capacitance", value);
    const pinNodes = new Map<string, number>([
      ["pos", nodeSlot],
      ["neg", 0],
    ]);
    const leaf = new AnalogCapacitorElement(pinNodes, props);
    leaf.label = label;
    return leaf;
  }

  private _buildSetupContext(): SetupContext {
    const engine = this;
    const params = this._params;
    return {
      solver: this._solver,
      temp: params.temp ?? 300.15,
      nomTemp: params.nomTemp ?? 300.15,
      // epsmin sourced from the live CKTCircuitContext (cktdefs.h:323 field),
      // falling back to params.epsmin ?? 1e-28 (DEFAULT_SIMULATION_PARAMS) when
      // the context is not yet constructed, mirroring the temp/nomTemp shape.
      epsmin: this._ctx?.cktEpsmin ?? (params.epsmin ?? 1e-28),
      copyNodesets: params.copyNodesets ?? false,
      makeVolt(label, suffix) { return engine._makeNode(label, suffix, "voltage"); },
      makeCur (label, suffix) { return engine._makeNode(label, suffix, "current"); },
      allocStates(n) {
        const off = engine._numStates;
        engine._numStates += n;
        return off;
      },
      findBranch(label) { return engine._findBranch(label, this); },
      findDevice(label) { return engine._deviceMap.get(label) ?? null; },
      // ASRCsetup IF_NODE resolution (asrcset.c:104-105): net label → node id.
      // 0 sentinel = ground / unknown net, matching ngspice's CKTfndNode miss.
      findNode(label) {
        const n = label.trim();
        if (n === "" || n === "0" || n.toLowerCase() === "gnd" || n.toLowerCase() === "ground") {
          return 0;
        }
        return engine._compiled?.labelToNodeId.get(n) ?? 0;
      },
    };
  }

  /** Port of CKTnewNode (cktnewn.c:23-43). Called by both makeVolt and
   *  makeCur with different `type` discriminators. */
  private _makeNode(label: string, suffix: string, type: "voltage" | "current"): number {
    const number = this._maxEqNum++;
    this._nodeTable.push({ name: `${label}#${suffix}`, number, type });
    return number;
  }

  private _findBranch(label: string, ctx: SetupContext): number {
    const el = this._deviceMap.get(label);
    if (!el) return 0;
    if (typeof (el as any).findBranchFor === "function") {
      return (el as any).findBranchFor(label, ctx);
    }
    return (el as any).branchIndex !== -1 ? (el as any).branchIndex : 0;
  }

  /** Walk of compiled.elements to build _deviceMap (A4.1). Every element
   *  is flat now- the engine's global ngspiceLoadOrder sort places every
   *  leaf (including the composite allocator/patcher sentinels) directly
   *  in `compiled.elements`, so no recursive sub-element traversal is
   *  needed. Each element is registered by its own label. */
  private _buildDeviceMap(elements: readonly AnalogElement[], prefix: string): void {
    for (const el of elements) {
      const fullLabel = prefix ? `${prefix}/${el.label}` : el.label;
      if (fullLabel) {
        this._deviceMap.set(fullLabel, el);
      }
    }
  }

  /** Pre-allocate nodeset and IC matrix handles after the per-element setup loop (A8). */
  private _allocateNodesetIcHandles(): void {
    for (const [node] of this._ctx!.nodesets) {
      this._ctx!.nodesetHandles.set(node, this._solver.allocElement(node, node));
    }
    for (const [node] of this._ctx!.ics) {
      this._ctx!.icHandles.set(node, this._solver.allocElement(node, node));
    }
  }

  /**
   * Port of CKTic (cktic.c:13-53). Runs once per analysis, after CKTsetup and
   * before the first NR solve (cktdojob.c:217-218 calls CKTic between an_init
   * and an_func). For every node carrying a .nodeset or .ic, it writes the
   * constrained value into BOTH the current RHS (CKTrhs) and the
   * previous-solution buffer (CKTrhsOld) via the dual-write at cktic.c:31,39:
   *
   *     ckt->CKTrhsOld[node->number] = ckt->CKTrhs[node->number] = node->nodeset; // :31
   *     ckt->CKTrhsOld[node->number] = ckt->CKTrhs[node->number] = node->ic;      // :39
   *
   * CKTrhsOld is the starting voltage vector the direct-NR level of CKTop reads
   * (cktop.c:46, carried into NIiter untouched), so seeding it makes NR
   * iteration 0 of a .nodeset/.ic circuit start from the constrained voltage.
   *
   * The CKTrhs zero pass (cktic.c:22-24) and the MODEUIC per-device DEVsetic
   * dispatch (cktic.c:43-49) are performed by the caller `_cktic`, which wraps
   * this seed between them; this method is only the nodeset/IC dual-write
   * (cktic.c:26-41). ctx.nodesets holds exactly the nsGiven nodes and ctx.ics
   * exactly the icGiven nodes (CKTsetNodPm analogue), so iterating each map IS
   * cktic.c's nsGiven / icGiven gate. The nodeset loop runs before the IC loop
   * to match cktic.c:27-40, so a node carrying both lands on its IC value
   * (cktic.c:39 overwrites cktic.c:31).
   */
  private _seedNodesetIcRhs(): void {
    const ctx = this._ctx!;
    const rhs = ctx.rhs;
    const rhsOld = ctx.rhsOld;
    for (const [node, value] of ctx.nodesets) {
      rhsOld[node] = rhs[node] = value;
    }
    for (const [node, value] of ctx.ics) {
      rhsOld[node] = rhs[node] = value;
    }
  }

  /**
   * ngspice CKTic (cktic.c), dispatched once before the transient-boot CKTop
   * (cktdojob.c:217-218). Three steps, in ngspice's order:
   *   1. under UIC, zero CKTrhs (cktic.c:22-24) so the device pass in step 3
   *      reads clean node voltages;
   *   2. write node .nodeset/.ic values into CKTrhs and CKTrhsOld (cktic.c:26-41,
   *      delegated to `_seedNodesetIcRhs`);
   *   3. under UIC, run each device's DEVsetic / `*getic.c` (cktic.c:43-49) so an
   *      un-given device initial condition is derived from the seeded CKTrhs node
   *      voltages (e.g. DIOgetic, diogetic.c:28-31) rather than left at its
   *      un-given sentinel.
   * The boot CKTop reads CKTrhsOld as its NR guess (cktop.c:46, dc-operating-
   * point.ts:358-360), which the zero never touches, so zeroing CKTrhs cannot
   * perturb the boot DCOP. The zero is confined to the UIC path: the device pass
   * it serves is UIC-only, and the non-UIC boot's rhs is already the fresh-zeroed
   * analysis buffer, so non-UIC boots are left byte-identical to pre-CKTic
   * behaviour. Devices ngspice gives no DEVsetic (ind, jfet, mos) do not
   * implement `getInitialConditions` and keep their hardcoded default.
   */
  private _cktic(elements: readonly AnalogElement[]): void {
    const ctx = this._ctx!;
    const uic = ctx.cktMode & MODEUIC;
    // cktic.c:22-24 — zero CKTrhs so the per-device DEVsetic below reads clean
    // node voltages. ngspice runs CKTic only when the job needs IC handling
    // (cktdojob.c:217, do_ic); the device DEVsetic pass it gates is UIC-only
    // (cktic.c:43). On the non-UIC boot there is no DEVsetic to feed and the
    // analysis-entry rhs is already the fresh-zeroed buffer, so the zero is
    // confined to the UIC path — leaving the non-UIC boot's rhs untouched.
    if (uic) ctx.rhs.fill(0);
    this._seedNodesetIcRhs();                 // cktic.c:26-41
    if (uic) {                                // cktic.c:43
      for (const el of elements) {
        el.getInitialConditions?.(ctx.rhs);   // cktic.c:46 — DEVsetic / *getic.c
      }
    }
  }

  /**
   * Transition from converged DCOP to the first transient timestep.
   *
   * Direct port of ngspice dctran.c:346-350:
   *
   *     ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN;
   *     ckt->CKTag[0] = ckt->CKTag[1] = 0;
   *     memcpy(ckt->CKTstate1, ckt->CKTstate0,
   *           (size_t) ckt->CKTnumStates * sizeof(double));
   *
   * Three statements. No cktLoad, no NR, no device.accept sweep, no
   * per-element ref refresh beyond the defensive resync below.
   */
  private _seedFromDcop(
    result: DcOpResult,
    _elements: readonly AnalogElement[],
    cac: ConcreteCompiledAnalogCircuit,
  ): void {
    const ctx = this._ctx!;
    ctx.rhs.set(result.nodeVoltages);

    // ctx.rhsOld is the NR initial guess for the first transient point. ngspice
    // carries CKTrhsOld there untouched (dctran.c:346-350 never writes it), and
    // CKTrhsOld holds the DCOP's PRE-final-iterate vector: NIiter swaps
    // CKTrhsOld<->CKTrhs at the top of each iteration and returns pre-swap on
    // convergence (niiter.c:944-955), so after the converged final solve
    // CKTrhsOld is the iterate that fed it, NOT the converged answer in CKTrhs.
    // The DCOP NR loop here already leaves ctx.rhsOld at exactly that pre-final
    // iterate (its own pre-swap return), for every node including ctx.makeVolt
    // primes. Overwriting it with the converged result.nodeVoltages would seed
    // the transient from the wrong vector and break first-point parity.

    for (const el of _elements) {
      if (typeof (el as any).initVoltages === "function") {
        (el as any).initVoltages(ctx.rhs);
      }
    }

    if (cac.statePool) {
      // dctran.c:291- CKTorder = 1.
      this._timestep.currentOrder = 1;

      // dctran.c:292-294- CKTdeltaOld[i] = CKTmaxStep for all 7 slots.
      for (let i = 0; i < ctx.deltaOld.length; i++) {
        ctx.deltaOld[i] = this._params.maxTimeStep;
      }

      // dctran.c:346- CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN
      // Preserve MODEUIC only; replace the analysis and INITF bits entirely.
      const uic = ctx.cktMode & MODEUIC;
      ctx.cktMode = uic | MODETRAN | MODEINITTRAN;

      // dctran.c:348- CKTag[0] = CKTag[1] = 0
      ctx.ag[0] = 0;
      ctx.ag[1] = 0;

      // dctran.c:349-350- memcpy(CKTstate1, CKTstate0, numStates*sizeof(double))
      // Copy current state (state0) into the "last accepted" slot (state1). No seeding of
      // state2..state7 yet- ngspice does that in the first-step acceptance
      // block (dctran.c:795-799), not here. See step()'s _stepCount === 0
      // branch for that seeding.
      cac.statePool.states[1].set(cac.statePool.states[0]);
    }
  }

  private _transitionState(newState: EngineState): void {
    this._engineState = newState;
    for (const listener of this._changeListeners) {
      listener(newState);
    }
  }

}
