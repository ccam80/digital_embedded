/**
 * MNAEngine — the concrete AnalogEngine implementation.
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
} from "../../core/analog-engine-interface.js";
import type { IntegrationMethod } from "../../core/analog-types.js";
import type { Diagnostic } from "../../compile/types.js";
import { DEFAULT_SIMULATION_PARAMS, resolveSimulationParams } from "../../core/analog-engine-interface.js";
import type { ResolvedSimulationParams } from "../../core/analog-engine-interface.js";
import { AcAnalysis } from "./ac-analysis.js";
import type { AcParams, AcResult } from "./ac-analysis.js";
import { SparseSolver } from "./sparse-solver.js";
import { TimestepController } from "./timestep.js";
import { HistoryStore, computeNIcomCof } from "./integration.js";
import { computeAgp, predictVoltages } from "./ni-pred.js";
import { DiagnosticCollector, makeDiagnostic } from "./diagnostics.js";
import { ConvergenceLog } from "./convergence-log.js";
import type { StepRecord, NRAttemptRecord } from "./convergence-log.js";

import { solveDcOperatingPoint } from "./dc-operating-point.js";
import type { DcOpNRPhase, DcOpNRAttemptOutcome } from "./dc-operating-point.js";
import { newtonRaphson } from "./newton-raphson.js";
import type { LimitingEvent } from "./newton-raphson.js";
import { CKTCircuitContext } from "./ckt-context.js";
import type { AnalogElement } from "./element.js";
import { isPoolBacked } from "./element.js";
import type { ConcreteCompiledAnalogCircuit as CompiledWithBridges } from "./compiled-analog-circuit.js";
import type { StatePool } from "./state-pool.js";
import { assertPoolIsSoleMutableState } from "../../solver/analog/state-schema.js";
import {
  MODEUIC, MODEDCOP, MODETRAN, MODETRANOP,
  MODEINITJCT, MODEINITTRAN, MODEINITPRED,
} from "./ckt-mode.js";

// ---------------------------------------------------------------------------
// ConcreteCompiledAnalogCircuit — minimal interface for what MNAEngine needs
// ---------------------------------------------------------------------------

/**
 * The runtime-narrowed interface that MNAEngine expects from its compiled
 * circuit. This matches the fields produced by the analog compiler (Task 1.5.1)
 * but is expressed as an interface so MNAEngine does not depend on that
 * concrete class directly.
 */
export interface ConcreteCompiledAnalogCircuit extends CompiledCircuit {
  /** Number of non-ground MNA nodes. */
  readonly nodeCount: number;
  /** Number of extra MNA rows for voltage sources and inductors. */
  readonly branchCount: number;
  /** Total MNA matrix dimension: nodeCount + branchCount. */
  readonly matrixSize: number;
  /** All analog elements with their stamp functions. */
  readonly elements: readonly AnalogElement[];
  /** Maps component label strings to MNA node IDs. */
  readonly labelToNodeId: Map<string, number>;
  /** Shared state pool for per-element operating-point state. */
  readonly statePool: StatePool;
}

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
  // NIpred predictor state lives on _ctx (agp, nodeVoltageHistory)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // CKTCircuitContext — pre-allocated god-object for NR/DC-OP hot paths
  // -------------------------------------------------------------------------
  private _ctx: CKTCircuitContext | null = null;

  // -------------------------------------------------------------------------
  // Compiled circuit reference
  // -------------------------------------------------------------------------
  private _compiled: ConcreteCompiledAnalogCircuit | null = null;

  private _elements: readonly AnalogElement[] = [];
  private _devProbeRan: boolean = false;

  // -------------------------------------------------------------------------
  // Engine lifecycle state
  // -------------------------------------------------------------------------
  private _engineState: EngineState = EngineState.STOPPED;
  private _changeListeners: EngineChangeListener[] = [];

  // -------------------------------------------------------------------------
  // Simulation time tracking
  // -------------------------------------------------------------------------
  private _simTime: number = 0;
  private _lastDt: number = 0;

  // -------------------------------------------------------------------------
  // Solver configuration
  // -------------------------------------------------------------------------
  private _params: ResolvedSimulationParams = { ...DEFAULT_SIMULATION_PARAMS };

  // -------------------------------------------------------------------------
  // Engine interface — Lifecycle
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
    this._elements = compiled.elements;
    this._devProbeRan = false;

    const { elements } = compiled;

    this._solver = new SparseSolver();
    this._history = new HistoryStore(elements.length);
    this._diagnostics = new DiagnosticCollector();
    this._convergenceLog.clear();

    this._simTime = 0;
    this._lastDt = 0;

    // Validate that pool-backed elements received their offsets from the compiler.
    //
    // Allocation is the compiler's responsibility (see compiler.ts, the loop
    // that assigns `stateBaseOffset` before constructing `StatePool`). Any
    // element that arrives here with `stateBaseOffset < 0` signals a real
    // upstream bug: a code path that produced a `CompiledAnalogCircuit`
    // without running allocation. We throw rather than paper over it,
    // because a silent fallback reassignment would hide future allocation
    // regressions as numerical wrongness (flat capacitor voltages, etc.)
    // rather than loud failures.
    const cac = compiled as CompiledWithBridges;
    if (cac.statePool) {
      for (const el of elements) {
        if (isPoolBacked(el) && el.stateBaseOffset < 0) {
          throw new Error(
            `MNAEngine.init(): reactive element arrived ` +
            `with stateBaseOffset=-1. Pool-backed elements must have offsets ` +
            `assigned at compile time (see compiler.ts state-pool allocation ` +
            `loop). A circuit produced without running that allocation step ` +
            `is invalid input to the engine.`,
          );
        }
      }
    }

    // Construct CKTCircuitContext for NR and DC-OP call sites.
    // Shares the same solver and elements as the rest of init().
    //
    // Order matters: the ctx constructor allocates ctx.deltaOld (length 7,
    // seeded to params.maxTimeStep). The TimestepController is then built
    // with a reference to THAT same array, so ctx.deltaOld and the
    // controller's internal CKTdeltaOld[] are identical by identity —
    // matches ngspice where CKTdeltaOld[7] lives on CKTcircuit. The
    // addBreakpoint closure captures `this._timestep` by reference, so it
    // resolves correctly after the controller is assigned below.
    this._ctx = new CKTCircuitContext(
      {
        nodeCount: compiled.nodeCount,
        branchCount: compiled.branchCount,
        matrixSize: compiled.matrixSize,
        elements: compiled.elements,
        statePool: cac.statePool ?? null,
      },
      this._params,
      (t) => this._timestep.addBreakpoint(t),
      this._solver,
    );
    this._timestep = new TimestepController(this._params, this._ctx.deltaOld);
    // Wire diagnostics
    this._ctx.diagnostics = this._diagnostics;

    this._seedBreakpoints();
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
    const cac = this._compiled as CompiledWithBridges | undefined;
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
    this._seedBreakpoints();
    this._transitionState(EngineState.STOPPED);
  }

  /** Release all resources. Engine must not be used after dispose(). */
  dispose(): void {
    this._compiled = null;
    this._ctx = null;
    this._history = new HistoryStore(0);
    this._diagnostics.clear();
    this._changeListeners = [];
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
    if (this._engineState === EngineState.ERROR) return;

    const { elements } = this._compiled;
    const params = this._params;
    const logging = this._convergenceLog.enabled;
    let stepRec: StepRecord | null = null;

    if (import.meta.env?.DEV && !this._devProbeRan) {
      this._devProbeRan = true;
      const statePool = (this._compiled as CompiledWithBridges).statePool ?? null;
      if (statePool) {
        const poolSnapshot = statePool.state0.slice();
        const ctx = this._ctx!;
        // Prime the solver so element.load() can call allocElement safely.
        // Without this the shared solver's column linked list is empty, and
        // every allocElement call corrupts it via undefined-index coercion —
        // the exact failure mode that hung tests using larger circuits.
        // The stamps produced here are discarded by the next cktLoad()'s
        // beginAssembly, so it costs us nothing to re-prime.
        ctx.solver.beginAssembly(ctx.matrixSize);
        for (const element of this._elements) {
          if (isPoolBacked(element)) {
            const violations = assertPoolIsSoleMutableState(
              element.stateSchema.owner ?? "unknown",
              element,
              () => {
                element.load(ctx.loadCtx);
              },
            );
            for (const v of violations) {
              const msg =
                `reactive-state-outside-pool: ${v.owner}.${v.field} changed during load()\n` +
                `but is not declared in the element's StateSchema. Mutable numeric state MUST\n` +
                `live in pool.state0 so the engine can roll it back on NR-failure and LTE-\n` +
                `rejection retries. Move ${v.field} into\n` +
                `a schema slot and access it via this.s0[this.base + SLOT_${v.field.replace(/^_/, "").toUpperCase()}].`;
              this._diagnostics.emit(
                makeDiagnostic("reactive-state-outside-pool", "error", msg, {
                  explanation: msg,
                  involvedElements: [],
                  simTime: this._simTime,
                }),
              );
            }
          }
        }
        statePool.state0.set(poolSnapshot);
      }
    }

    const ctx = this._ctx!;
    ctx.rhsOld.set(ctx.rhs);
    const statePool = (this._compiled as CompiledWithBridges).statePool ?? null;

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
    let olddelta = dt;    // ngspice dctran.c:729 — tracks previous delta for two-strike delmin

    // ngspice dctran.c:704-706 — rotate deltaOld BEFORE entering the loop.
    this._timestep.rotateDeltaOld();

    // ngspice dctran.c:715-723 — rotate state vectors BEFORE retry loop.
    // Pointer swap: states[0] is fresh recycled storage, states[1] = previous accepted.
    // Elements read/write states[0] during NR; states[1] holds the last accepted state.
    if (statePool) {
      statePool.rotateStateVectors();
    }

    // Phase tracking for stepPhaseHook: first attempt is tranInit on step 0, tranNR thereafter.
    // Subsequent loop iterations in the same step are retries.
    let _stepAttemptCount = 0;

    for (;;) {
      // ngspice dctran.c:735 — deltaOld[0] = delta each iteration.
      this._timestep.setDeltaOldCurrent(dt);

      // ngspice dctran.c:731 — advance simTime at top of each iteration.
      this._simTime += dt;

      // Publish the advanced simTime to timeRef so time-varying sources
      // (AC voltage/current) evaluate at the correct time during the NR
      // solve that follows.
      const cac = this._compiled as CompiledWithBridges | undefined;
      if (cac?.timeRef) cac.timeRef.value = this._simTime;

      // NIpred: compute agp[] then predict voltages as NR initial guess.
      // Fires on every retry iteration (dt changes on NR-failure/LTE-rejection).
      // Matches ngspice dctran.c:734 NIcomCof + dctran.c:750 NIpred.
      // Gated on _stepCount > 0: on step 0, ctx.rhs already holds the
      // converged DC-OP solution (written at seedHistory). ngspice does not run
      // MODEINITPRED under MODEINITTRAN, so the DC-OP result in CKTrhsOld is
      // used directly as the NR initial guess.
      if (this._stepCount > 0 && (this._params.predictor ?? false)) {
        computeAgp(this._timestep.currentMethod, this._timestep.currentOrder,
          dt, this._timestep.deltaOld, ctx.agp);
        predictVoltages(ctx.nodeVoltageHistory, this._timestep.deltaOld,
          this._timestep.currentOrder, this._timestep.currentMethod,
          ctx.agp, ctx.rhs);
      }

      // --- Phase hook: begin attempt ---
      if (this.stepPhaseHook) {
        let attemptPhase: "tranInit" | "tranNR" | "tranNrRetry" | "tranLteRetry";
        if (this._stepCount === 0 && _stepAttemptCount === 0) {
          attemptPhase = "tranInit";
        } else if (_stepAttemptCount === 0) {
          attemptPhase = "tranNR";
        } else {
          // Retry: we can't distinguish NR retry from LTE retry here; mark generic retry.
          // The actual outcome is set by the NR/LTE exit paths below.
          attemptPhase = "tranNrRetry";
        }
        this.stepPhaseHook.onAttemptBegin(attemptPhase, dt);
      }
      _stepAttemptCount++;

      // --- NIcomCof (ngspice dctran.c:736) ---
      // Recompute ag[] integration coefficients before each NR solve.
      // Elements read ag[] via ctx.loadCtx.ag inside their load() calls.
      if (statePool) {
        statePool.dt = dt;
        computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
          this._timestep.currentMethod, this._ctx!.ag, this._ctx!.gearMatScratch);
        // MODEINITTRAN is already live in ctx.cktMode from _seedFromDcop.
        // niiter's INITF dispatcher will clear it to MODEINITFLOAT after the
        // first cktLoad. No deferred write needed.
      }

      // --- NR solve (ngspice dctran.c:770 NIiter) ---
      // ctx.deltaOld and timestep.deltaOld share the same backing array
      // (wired in MNAEngine.init), so rotateDeltaOld()/setDeltaOldCurrent()
      // updates are visible here without an explicit copy loop.
      //
      // xfact = deltaOld[0] / deltaOld[1] for predictor extrapolation in
      // element load(). Written here so all elements read the correct value
      // during this NR call.
      ctx.loadCtx.xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
      // dt for reactive elements to use in load() (CKTdelta).
      ctx.loadCtx.dt = dt;
      // Synchronize integration order and method with the timestep controller
      // before NR. ngspice stores CKTorder and CKTintegrateMethod on the CKT
      // struct itself — a single source of truth read by both NIcomCof (ag[])
      // and every device load routine. Our timestep controller is a separate
      // object; without this copy, loadCtx.order/method stay at their ckt-
      // context.ts:537 init values while timestep.currentOrder/currentMethod
      // promote after LTE acceptance (tryOrderPromotion). That desync causes
      // niIntegrate to apply the order-1 formula to order-2 ag[] coefficients
      // (ag[1] = xmu/(1-xmu) = 1.0 for TRAP order 2, interpreted as -1/dt
      // under order 1), producing catastrophic companion-current errors.
      ctx.loadCtx.order = this._timestep.currentOrder;
      ctx.loadCtx.method = this._timestep.currentMethod;
      ctx.maxIterations = params.transientMaxIterations;
      ctx.enableBlameTracking = logging;
      ctx.postIterationHook = this.postIterationHook;
      ctx.detailedConvergence = this.detailedConvergence;
      ctx.limitingCollector = this.limitingCollector;
      ctx.dcopModeLadder = null;
      ctx.exactMaxIterations = false;
      ctx.onIteration0Complete = null;
      // ngspice dctran.c:794 — MODEINITPRED is set AFTER NIiter returns, not
      // before. On the first transient step the mode is MODEINITTRAN (set by
      // _seedFromDcop); niiter's INITF dispatcher clears that to MODEINITFLOAT
      // after the first cktLoad. For all subsequent steps, dctran.c:794's
      // post-NIiter write puts MODEINITPRED back on cktMode (in the acceptance
      // block below), which niiter again clears to MODEINITFLOAT in its
      // dispatcher. No per-step write is needed here.
      newtonRaphson(ctx);
      const nrResult = ctx.nrResult;

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
            stepRec!.attempts[stepRec!.attempts.length - 1].iterationDetails = drainable.drainForLog();
          }
        }
      }

      if (!nrResult.converged) {
        // --- NR FAILED (ngspice dctran.c:793-810) ---
        this.stepPhaseHook?.onAttemptEnd("nrFailedRetry", false);
        this._simTime -= dt;                              // ngspice dctran.c:796
        ctx.rhs.set(ctx.rhsOld);
        dt = dt / 8;                                    // ngspice dctran.c:802
        this._timestep.currentDt = dt;
        this._timestep.currentOrder = 1;                // ngspice dctran.c:810 — order, NOT method
        // dctran.c:820-822 — on NR failure while firsttime, restore MODEINITTRAN
        // on CKTmode. "firsttime" in ngspice is 1 between dctran.c:189 and 864
        // (the first successful step's acceptance). We detect it as _stepCount === 0.
        if (this._stepCount === 0 && statePool) {
          ctx.cktMode = (ctx.cktMode & MODEUIC) | MODETRAN | MODEINITTRAN;
        }
        // fall through to delmin check below
      } else {
        // --- NR CONVERGED — evaluate LTE (ngspice dctran.c:830+) ---
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

        // ngspice dctran.c:856-876 — trial promotion from BDF-1 to trapezoidal.
        // Runs INSIDE LTE check, before accept/reject, matching ngspice CKTtrunc ordering.
        // Gate: only attempt when order is 1 and LTE result is >= 90% of the executed step.
        if (this._timestep.currentOrder === 1 && newDt > 0.9 * dt) {
          this._timestep.tryOrderPromotion(elements, this._history, this._simTime, dt);
        }

        if (!this._timestep.shouldReject(worstRatio)) {
          // --- LTE ACCEPTED (ngspice dctran.c:862-912) ---
          this.stepPhaseHook?.onAttemptEnd("accepted", true);
          break;  // exit the for(;;) — proceed to acceptance block
        }

        // --- LTE REJECTED (ngspice dctran.c:917-931) ---
        this.stepPhaseHook?.onAttemptEnd("lteRejectedRetry", true);
        this._simTime -= dt;                            // ngspice dctran.c:920
        if (logging) stepRec!.lteRejected = true;

        ctx.rhs.set(ctx.rhsOld);
        dt = newDt;                                     // ngspice dctran.c:926
        this._timestep.currentDt = dt;
        // fall through to delmin check below
      }

      // --- Common delmin check (ngspice dctran.c:934-945) ---
      if (dt <= params.minTimeStep) {
        if (olddelta > params.minTimeStep) {
          // First time at delmin — allow one more try (ngspice dctran.c:936)
          dt = params.minTimeStep;
          this._timestep.currentDt = dt;
        } else {
          // Second consecutive delmin — give up (ngspice dctran.c:941-943)
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

    // Accept the timestep — rotation already happened before the retry loop.
    if (statePool) {
      statePool.tranStep++;
      // ngspice dctran.c:795-799: on firsttime acceptance, seed s2..s7 from s1.
      // states[1] already holds the DCOP state from _seedFromDcop (bcopy at
      // dctran.c:349-350). seedFromState1 copies s1 into s2..s7, matching
      // dctran.c:795-799. Runs once per first-step acceptance.
      if (this._stepCount === 0) {
        statePool.seedFromState1();
      }
    }

    // NIpred: push fully-accepted solution into history for next step predictor.
    // Only fires after both NR convergence AND LTE acceptance — never on rejected attempts.
    // ngspice: CKTsols rotation in dctran.c acceptance block.
    ctx.nodeVoltageHistory.rotateNodeVoltages(ctx.rhs);

    if (logging) {
      stepRec!.acceptedDt = dt;
      stepRec!.exitMethod = this._timestep.currentMethod;
      this._convergenceLog.record(stepRec!);
    }

    const cac = this._compiled as CompiledWithBridges | undefined;
    if (cac?.timeRef) cac.timeRef.value = this._simTime;
    this._lastDt = dt;

    // Advance timestep controller state
    this._timestep.currentDt = newDt;
    try {
      this._timestep.accept(this._simTime);
    } catch (err) {
      this._diagnostics.emit(
        makeDiagnostic("convergence-failed", "error", String(err instanceof Error ? err.message : err), {
          explanation: "TimestepController.accept() invariant violated — simTime did not advance monotonically.",
          involvedElements: [],
          simTime: this._simTime,
        }),
      );
      this._transitionState(EngineState.ERROR);
      return;
    }

    // Post-acceptance: notify elements (companion state, flux/charge history).
    // Matches ngspice DEVaccept — called once per accepted step.
    // ctx.loadCtx.rhs already points at ctx.rhs (set at construction time in
    // ckt-context.ts). Set dt to the accepted timestep before calling accept().
    const addBP = ctx.addBreakpointBound;
    ctx.loadCtx.dt = this._lastDt;
    for (const el of elements) {
      if (el.accept) {
        el.accept(ctx.loadCtx, this._simTime, addBP);
      }
    }

    // Schedule next waveform breakpoints after acceptance
    for (const el of elements) {
      if (el.acceptStep) {
        el.acceptStep(this._simTime, addBP);
      }
    }

    // ngspice dctran.c:794 — `ckt->CKTmode = (ckt->CKTmode & MODEUIC) |
    // MODETRAN | MODEINITPRED;` Set AFTER NIiter returns, landing mode for
    // the NEXT step's first cktLoad. Under #ifndef PREDICTOR (ngspice
    // default), MODEINITPRED is effectively equivalent to MODEINITFLOAT;
    // the distinction matters only if PREDICTOR is enabled at ngspice build
    // time (it is not, by default).
    const uicBit = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBit | MODETRAN | MODEINITPRED;

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

  /** Current integration order (1 = BDF-1 startup, 2 = order-2 free-running). */
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

  /** Active numerical integration method for the current step. */
  get integrationMethod(): IntegrationMethod {
    return this._timestep.currentMethod;
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
  // Engine interface — Measurement observers
  // -------------------------------------------------------------------------

  private _measurementObservers: MeasurementObserver[] = [];
  private _stepCount: number = 0;
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
  // AnalogEngine interface — DC Analysis
  // -------------------------------------------------------------------------

  /**
   * Find the DC operating point of the circuit.
   *
   * Delegates to the three-level fallback solver. Stores the resulting node
   * voltages in `ctx.rhs` so subsequent `step()` calls start from the
   * correct operating point.
   */
  dcOperatingPoint(): DcOpResult {
    if (!this._compiled) {
      return {
        converged: false,
        method: "direct",
        iterations: 0,
        nodeVoltages: new Float64Array(0),
        diagnostics: [],
      };
    }

    const { elements } = this._compiled;
    this._diagnostics.clear();

    const cac = this._compiled as CompiledWithBridges;
    if (cac.statePool) {
      cac.statePool.reset();
      for (const el of this._elements) {
        if (isPoolBacked(el)) {
          el.initState(cac.statePool);
        }
      }
    }

    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    // dcop.c:82 — firstmode = (CKTmode & MODEUIC) | MODEDCOP | MODEINITJCT
    // Standalone .OP is MODEDCOP only (not MODETRANOP). vsrcload.c:410-411
    // scales source value by CKTsrcFact ONLY under MODETRANOP, so for
    // standalone .OP the source-load srcFact path is gated off by the
    // analysis bits. CKTsrcFact enters at 1 — the source-stepping sub-solve
    // (gillespieSrc / spice3Src) mutates ctx.srcFact internally during the
    // ramp, but the ladder entry value must be 1.
    ctx.srcFact = 1;
    const uicBitDcop = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBitDcop | MODEDCOP | MODEINITJCT;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
    const result = ctx.dcopResult;

    if (this._convergenceLog.enabled) {
      const drainable = this.postIterationHook as unknown as { drainForLog?: () => NRAttemptRecord["iterationDetails"] };
      if (typeof drainable?.drainForLog === "function") {
        const dcopRec: StepRecord = {
          stepNumber: -1,
          simTime: 0,
          entryDt: 0,
          acceptedDt: 0,
          entryMethod: "bdf1",
          exitMethod: "bdf1",
          lteWorstRatio: 0,
          lteProposedDt: 0,
          lteRejected: false,
          outcome: result.converged ? "accepted" : "error",
          attempts: [{
            dt: 0,
            method: "bdf1",
            iterations: result.iterations,
            converged: result.converged,
            blameElement: -1,
            blameNode: -1,
            trigger: "initial",
            iterationDetails: drainable.drainForLog(),
          }],
        };
        this._convergenceLog.record(dcopRec);
      }
    }

    if (result.converged) {
      this._seedFromDcop(result, elements, cac);
    }

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
   * @returns DcOpResult — same shape as dcOperatingPoint()
   */
  _transientDcop(): DcOpResult {
    if (!this._compiled) {
      return {
        converged: false,
        method: "direct",
        iterations: 0,
        nodeVoltages: new Float64Array(0),
        diagnostics: [],
      };
    }

    const { elements } = this._compiled;
    this._diagnostics.clear();

    const cac = this._compiled as CompiledWithBridges;
    if (cac.statePool) {
      cac.statePool.reset();
      for (const el of this._elements) {
        if (isPoolBacked(el)) {
          el.initState(cac.statePool);
        }
      }
    }

    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    // dctran.c:190,231 — save_mode = (CKTmode & MODEUIC) | MODETRANOP | MODEINITJCT
    // Preserve UIC; replace analysis and INITF bits entirely. Reset to the
    // first-transient-step mode inside _seedFromDcop after DCOP converges.
    // srcFact always enters at 1; dctran.c does not read srcFact at transient-
    // boot DCOP entry (cktop.c:385 sets CKTsrcFact=0 inside gillespie sub-solve).
    ctx.srcFact = 1;
    const uicBitTransDcop = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBitTransDcop | MODETRANOP | MODEINITJCT;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
    const result = ctx.dcopResult;

    if (result.converged) {
      this._seedFromDcop(result, elements, cac);
    }

    return result;
  }

  /** Public entry point for transient DC-op. Delegates to _transientDcop(). */
  transientDcop(): DcOpResult {
    return this._transientDcop();
  }

  /**
   * Run an AC small-signal frequency sweep analysis.
   *
   * Creates an `AcAnalysis` instance using the engine's compiled circuit,
   * runs the sweep with the given params, and returns the `AcResult`.
   * The engine must be initialised before calling this method.
   */
  acAnalysis(params: AcParams): AcResult {
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

    const ac = new AcAnalysis(this._compiled, this._params);
    return ac.run(params);
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Simulation time
  // -------------------------------------------------------------------------

  /** Current simulation time in seconds. */
  get simTime(): number {
    return this._simTime;
  }

  /** Restore simulation time (used by hot-recompile). */
  set simTime(t: number) {
    this._simTime = t;
    const cac = this._compiled as CompiledWithBridges | undefined;
    if (cac?.timeRef) cac.timeRef.value = t;
  }

  /** Last accepted timestep in seconds. */
  get lastDt(): number {
    return this._lastDt;
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface — State access
  // -------------------------------------------------------------------------

  /**
   * Return the voltage at MNA node `nodeId` (referenced to ground).
   *
   * Node 0 is ground (always 0 V). Nodes 1..nodeCount are non-ground
   * voltages stored at solver indices 0..nodeCount-1.
   */
  getNodeVoltage(nodeId: number): number {
    if (nodeId <= 0 || !this._ctx) return 0;
    const idx = nodeId - 1;
    if (idx >= this._ctx.rhs.length) return 0;
    return this._ctx.rhs[idx];
  }

  setNodeVoltage(nodeId: number, voltage: number): void {
    if (nodeId <= 0 || !this._ctx) return;
    const idx = nodeId - 1;
    if (idx >= this._ctx.rhs.length) return;
    this._ctx.rhs[idx] = voltage;
    this._ctx.rhsOld[idx] = voltage;
  }

  /**
   * Return the current through MNA branch row `branchId`.
   *
   * Branch rows are stored after node voltages in the solution vector.
   * `branchId` is 0-based within the branch block.
   */
  getBranchCurrent(branchId: number): number {
    if (!this._compiled || !this._ctx) return 0;
    const offset = this._compiled.nodeCount + branchId;
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
    for (let i = 0; i < currents.length && i < el.pinNodeIds.length; i++) {
      power += this.getNodeVoltage(el.pinNodeIds[i]) * currents[i];
    }
    return power;
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Configuration
  // -------------------------------------------------------------------------

  /**
   * Update solver parameters. Merges partial set into active SimulationParams.
   * Rebuilds the timestep controller so new bounds take effect immediately.
   */
  configure(params: Partial<SimulationParams>): void {
    this._params = resolveSimulationParams({ ...this._params, ...params });
    // Non-destructive update: preserves currentDt (clamped to new maxTimeStep),
    // _acceptedSteps, _deltaOld history, currentOrder, currentMethod, and the
    // breakpoint queue. Only tolerance / step-bound fields are refreshed.
    this._timestep.updateParams(this._params);
    // Propagate refreshed tolerances into the CKTCircuitContext — without this,
    // NR still reads the stale constructor-captured reltol/iabstol/voltTol.
    if (this._ctx) {
      this._ctx.refreshTolerances(this._params);
    }
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Diagnostics
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
    return (this._compiled as CompiledWithBridges | undefined)?.statePool ?? null;
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
    onAttemptBegin(phase: DcOpNRPhase | "tranInit" | "tranNR" | "tranNrRetry" | "tranLteRetry", dt: number): void;
    onAttemptEnd(outcome: DcOpNRAttemptOutcome | "accepted" | "nrFailedRetry" | "lteRejectedRetry" | "finalFailure", converged: boolean): void;
  } | null = null;

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Breakpoints
  // -------------------------------------------------------------------------

  /** Register a simulation time at which the timestep must land exactly. */
  addBreakpoint(time: number): void {
    this._timestep.addBreakpoint(time);
  }

  /** Remove all registered breakpoints and reseed from element sources. */
  clearBreakpoints(): void {
    this._timestep.clearBreakpoints();
    this._seedBreakpoints();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Transition from converged DCOP to the first transient timestep.
   *
   * Direct port of ngspice dctran.c:346-350:
   *
   *     ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN;
   *     ckt->CKTag[0] = ckt->CKTag[1] = 0;
   *     bcopy(ckt->CKTstate0, ckt->CKTstate1,
   *           (size_t) ckt->CKTnumStates * sizeof(double));
   *
   * Three statements. No cktLoad, no NR, no device.accept sweep, no
   * per-element ref refresh beyond the defensive resync below.
   */
  private _seedFromDcop(
    result: DcOpResult,
    _elements: readonly AnalogElement[],
    cac: CompiledWithBridges,
  ): void {
    const ctx = this._ctx!;
    ctx.rhs.set(result.nodeVoltages);

    for (const el of _elements) {
      if (typeof (el as any).initVoltages === "function") {
        (el as any).initVoltages(ctx.rhs);
      }
    }

    if (cac.statePool) {
      // dctran.c:346 — CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN
      // Preserve MODEUIC only; replace the analysis and INITF bits entirely.
      const uic = ctx.cktMode & MODEUIC;
      ctx.cktMode = uic | MODETRAN | MODEINITTRAN;

      // dctran.c:348 — CKTag[0] = CKTag[1] = 0
      ctx.ag[0] = 0;
      ctx.ag[1] = 0;

      // dctran.c:349-350 — bcopy(CKTstate0, CKTstate1, numStates*sizeof(double))
      // Copy current state into the "last accepted" slot. No seeding of
      // state2..state7 yet — ngspice does that in the first-step acceptance
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

  /**
   * Seed the breakpoint queue from all elements that implement nextBreakpoint.
   * Called once after init(), reset(), and configure() to populate the queue
   * with the first upcoming edge for each periodic source.
   */
  private _seedBreakpoints(): void {
    if (!this._compiled) return;
    for (const el of this._compiled.elements) {
      if (typeof el.nextBreakpoint === "function") {
        const first = el.nextBreakpoint(this._simTime);
        if (first !== null) {
          this._timestep.insertForSource(first, el);
        }
      }
      if (typeof el.registerRefreshCallback === "function") {
        el.registerRefreshCallback(() => this.refreshBreakpointForSource(el));
      }
    }
  }

  /**
   * Refresh the queue entry for a source after a setParam change that
   * invalidates its outstanding breakpoint (e.g. frequency/phase change).
   */
  refreshBreakpointForSource(source: AnalogElement): void {
    if (!this._compiled) return;
    const newNextTime =
      typeof source.nextBreakpoint === "function"
        ? source.nextBreakpoint(this._simTime)
        : null;
    this._timestep.refreshForSource(source, newNextTime);
  }

}
