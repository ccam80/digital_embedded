/**
 * MNAEngine — the concrete AnalogEngine implementation.
 *
 * Orchestrates SparseSolver, MNAAssembler, TimestepController, HistoryStore,
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
import type { Diagnostic } from "../../compile/types.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../core/analog-engine-interface.js";
import { AcAnalysis } from "./ac-analysis.js";
import type { AcParams, AcResult } from "./ac-analysis.js";
import { SparseSolver } from "./sparse-solver.js";
import { TimestepController } from "./timestep.js";
import { HistoryStore } from "./integration.js";
import { DiagnosticCollector, makeDiagnostic } from "./diagnostics.js";
import { ConvergenceLog } from "./convergence-log.js";
import type { StepRecord } from "./convergence-log.js";

import { solveDcOperatingPoint } from "./dc-operating-point.js";
import { newtonRaphson } from "./newton-raphson.js";
import type { LimitingEvent } from "./newton-raphson.js";
import type { AnalogElement, PoolBackedAnalogElement } from "./element.js";
import { isPoolBacked } from "./element.js";
import type { ConcreteCompiledAnalogCircuit as CompiledWithBridges } from "./compiled-analog-circuit.js";
import type { StatePool } from "./state-pool.js";
import { assertPoolIsSoleMutableState } from "../../solver/analog/state-schema.js";

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
  // State vectors (allocated in init, sized to matrixSize)
  // -------------------------------------------------------------------------
  private _voltages: Float64Array = new Float64Array(0);
  private _prevVoltages: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Hoisted working buffers — allocated once in init() and reused every step.
  //
  // `_nrVoltages` and `_nrPrevVoltages`: per-iteration voltage arrays for
  // the NR solver. Sized to `matrixSize`.
  // -------------------------------------------------------------------------
  private _nrVoltages: Float64Array = new Float64Array(0);
  private _nrPrevVoltages: Float64Array = new Float64Array(0);

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
  private _params: SimulationParams = { ...DEFAULT_SIMULATION_PARAMS };

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

    const { matrixSize, elements } = compiled;

    this._voltages = new Float64Array(matrixSize);
    this._prevVoltages = new Float64Array(matrixSize);

    // Hoisted NR working buffers (see field declarations for rationale).
    this._nrVoltages = new Float64Array(matrixSize);
    this._nrPrevVoltages = new Float64Array(matrixSize);

    this._solver = new SparseSolver();
    this._timestep = new TimestepController(this._params);
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

    this._seedBreakpoints();
    this._transitionState(EngineState.STOPPED);
  }

  /** Reset voltages, history, and simulation time to initial state. */
  reset(): void {
    this._voltages.fill(0);
    this._prevVoltages.fill(0);
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
    this._timestep = new TimestepController(this._params);
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
    this._voltages = new Float64Array(0);
    this._prevVoltages = new Float64Array(0);
    this._nrVoltages = new Float64Array(0);
    this._nrPrevVoltages = new Float64Array(0);
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

    const { elements, matrixSize, nodeCount } = this._compiled;
    const params = this._params;
    const logging = this._convergenceLog.enabled;
    let stepRec: StepRecord | null = null;

    if (import.meta.env?.DEV && !this._devProbeRan) {
      this._devProbeRan = true;
      const statePool = (this._compiled as CompiledWithBridges).statePool ?? null;
      if (statePool) {
        const solver = this._solver;
        const voltages = this._voltages;
        const dt = this._timestep.getClampedDt(this._simTime);
        const method = this._timestep.currentMethod;
        const poolSnapshot = statePool.state0.slice();
        for (const element of this._elements) {
          if (isPoolBacked(element)) {
            const violations = assertPoolIsSoleMutableState(
              element.stateSchema.owner ?? "unknown",
              element,
              () => {
                element.stamp(solver);
                if (element.isReactive && element.stampCompanion) {
                  element.stampCompanion(dt, method, voltages, this._timestep.currentOrder, this._timestep.deltaOld);
                }
                if (element.isNonlinear && element.updateOperatingPoint) {
                  element.updateOperatingPoint(voltages);
                }
              },
            );
            for (const v of violations) {
              const msg =
                `reactive-state-outside-pool: ${v.owner}.${v.field} changed during stamp/stampCompanion\n` +
                `but is not declared in the element's StateSchema. Mutable numeric state MUST\n` +
                `live in pool.state0 so the engine can roll it back on NR-failure and LTE-\n` +
                `rejection retries (see analog-engine.ts:297-302, 369-371). Move ${v.field} into\n` +
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

    this._prevVoltages.set(this._voltages);
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

    for (;;) {
      statePool?.state0.set(statePool.state1);

      // ngspice dctran.c:735 — deltaOld[0] = delta each iteration.
      this._timestep.setDeltaOldCurrent(dt);

      // ngspice dctran.c:731 — advance simTime at top of each iteration.
      this._simTime += dt;

      // --- Companion stamp (ngspice dctran.c:736 NIcomCof) ---
      // Always called, including step 0. ngspice recomputes ag[] to real values
      // (1/h, -1/h) via NIcomCof BEFORE the first Newton solve (dctran.c:736).
      // The MODEINITTRAN "transparent at DC OP" behavior comes from seedHistory
      // copying Q_dcop into s1: BDF-1 produces geq=C/h (cap in matrix) but
      // zero net current at the DC operating point voltage.
      for (const el of elements) {
        if (el.isReactive && el.stampCompanion) {
          el.stampCompanion(dt, this._timestep.currentMethod, this._voltages, this._timestep.currentOrder, this._timestep.deltaOld);
        }
      }

      // --- NR solve (ngspice dctran.c:770 NIiter) ---
      const nrResult = newtonRaphson({
        solver: this._solver,
        elements,
        matrixSize,
        nodeCount,
        maxIterations: params.transientMaxIterations,
        reltol: params.reltol,
        abstol: params.abstol,
        iabstol: params.iabstol,
        initialGuess: this._voltages,
        diagnostics: this._diagnostics,
        voltagesBuffer: this._nrVoltages,
        prevVoltagesBuffer: this._nrPrevVoltages,
        enableBlameTracking: logging,
        postIterationHook: this.postIterationHook ?? undefined,
        preIterationHook: (_iteration, iterVoltages) => {
          const currentMethod = this._timestep.currentMethod;
          for (const el of elements) {
            if (el.isReactive && el.isNonlinear && el.stampCompanion) {
              el.stampCompanion(dt, currentMethod, iterVoltages, this._timestep.currentOrder, this._timestep.deltaOld);
            }
          }
        },
      });

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
      }

      if (!nrResult.converged) {
        // --- NR FAILED (ngspice dctran.c:793-810) ---
        this._simTime -= dt;                              // ngspice dctran.c:796
        this._voltages.set(this._prevVoltages);
        dt = dt / 8;                                    // ngspice dctran.c:802
        this._timestep.currentDt = dt;
        this._timestep.currentOrder = 1;                // ngspice dctran.c:810 — order, NOT method
        // fall through to delmin check below
      } else {
        // --- NR CONVERGED — evaluate LTE (ngspice dctran.c:830+) ---
        this._timestep.currentDt = dt;
        this._voltages.set(nrResult.voltages);

        // Update charge/flux with converged voltages so LTE sees accurate Q.
        // Also recomputes ccap from the converged charge so the next step's
        // trapezoidal recursion starts from the correct companion current.
        for (const el of elements) {
          if (el.isReactive && el.updateChargeFlux) {
            el.updateChargeFlux(this._voltages, dt, this._timestep.currentMethod, this._timestep.currentOrder, this._timestep.deltaOld);
          }
        }

        // MODEINITTRAN (ngspice capload.c:60-62, bjtload.c:691-699):
        // On the first transient step, copy s0 → s1 so that q0 == q1.
        // Without this, cktTerr sees a step function (post-NR Q vs DCOP Q)
        // and rejects with a massive divided difference.
        if (this._stepCount === 0 && statePool) {
          statePool.states[1].set(statePool.states[0]);
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

        if (!this._timestep.shouldReject(worstRatio)) {
          // --- LTE ACCEPTED (ngspice dctran.c:862-912) ---
          break;  // exit the for(;;) — proceed to acceptance block
        }

        // --- LTE REJECTED (ngspice dctran.c:917-931) ---
        this._simTime -= dt;                            // ngspice dctran.c:920
        if (logging) stepRec!.lteRejected = true;

        this._voltages.set(this._prevVoltages);
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

    // Accept the timestep
    if (statePool) {
      statePool.acceptTimestep();
      if (this._stepCount === 0) {
        statePool.seedFromState1();
      }
      statePool.tranStep++;
      statePool.refreshElementRefs(elements.filter(isPoolBacked) as unknown as PoolBackedAnalogElement[]);
    }

    if (logging) {
      stepRec!.acceptedDt = dt;
      stepRec!.exitMethod = this._timestep.currentMethod;
      this._convergenceLog.record(stepRec!);
    }

    const cac = this._compiled as CompiledWithBridges | undefined;
    if (cac?.timeRef) cac.timeRef.value = this._simTime;
    this._lastDt = dt;

    // Push history for BDF-2 method switching heuristic.
    // Tracks v[pin0] - v[pin1] as a representative voltage for oscillation
    // detection. For 2-terminal reactive elements this is the terminal voltage.
    // For multi-terminal reactive elements it's the voltage across the first
    // two pinLayout pins — an approximation sufficient for method switching.
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.isReactive && el.pinNodeIds.length >= 2) {
        const nA = el.pinNodeIds[0];
        const nB = el.pinNodeIds[1];
        const vA = nA > 0 && nA - 1 < nodeCount ? this._voltages[nA - 1] : 0;
        const vB = nB > 0 && nB - 1 < nodeCount ? this._voltages[nB - 1] : 0;
        this._history.push(i, vA - vB);
      }
    }

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
    this._timestep.checkMethodSwitch(elements, this._history);

    // ngspice dctran.c:856-876 — trial promotion from BDF-1 to trapezoidal.
    // Gate: only attempt when the order-1 newDt > .9 * dt (LTE result exceeds
    // 90% of the executed step). Matches ngspice dctran.c:862.
    if (newDt > 0.9 * dt) {
      this._timestep.tryOrderPromotion(elements, this._history, this._simTime, dt);
    }

    // Run companion-state updates (edge detection, pin companion refresh,
    // latched logic levels) once on the accepted solution. Must run BEFORE
    // updateState so any downstream consumer sees post-edge latched state.
    // Never runs on rejected LTE retries or inside NR — both are handled by
    // the retry loops above, which restore voltages and re-enter the solver.
    for (const el of elements) {
      if (el.updateCompanion) {
        el.updateCompanion(dt, method, this._voltages);
      }
    }

    // Update non-MNA state for elements that track it
    for (const el of elements) {
      if (el.updateState) {
        el.updateState(dt, this._voltages);
      }
    }

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
   * voltages in `_voltages` so subsequent `step()` calls start from the
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

    const { elements, matrixSize, nodeCount } = this._compiled;
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

    const result = solveDcOperatingPoint({
      solver: this._solver,
      elements,
      matrixSize,
      nodeCount,
      params: this._params,
      diagnostics: this._diagnostics,
      statePool: cac.statePool ?? null,
      postIterationHook: this.postIterationHook ?? undefined,
    });

    if (result.converged) {
      this._voltages.set(result.nodeVoltages);

      // Write initial charge/flux from the DC operating point so that
      // seedHistory propagates correct Q values into all history slots.
      // Without this, Q=0 in history causes cktTerr to see a step function
      // on the first transient step → LTE rejection → stagnation.
      // (ngspice equivalent: CAPload writes state0[qcap] during DCOP,
      // then dctran.c:342 bcopy seeds state1 from state0.)
      // dt=0 and dummy params: ccap recomputation is irrelevant at DC OP.
      for (const el of elements) {
        if (el.isReactive && el.updateChargeFlux) {
          el.updateChargeFlux(this._voltages, 0, "bdf1", 1, []);
        }
      }

      if (cac.statePool) {
        cac.statePool.seedHistory();
        cac.statePool.refreshElementRefs(elements.filter(isPoolBacked) as unknown as PoolBackedAnalogElement[]);
      }

      // Seed per-timestep companion state from the DC operating point.
      // Elements with sentinel-initialized edge-detection state (e.g.
      // behavioral flip-flops with _prevClockVoltage=NaN) use this call to
      // capture the DC steady-state voltages so the first transient step
      // does not mis-fire an edge on a signal that was already at its level
      // during DC op. dt=0 signals "no time elapsed"; method is irrelevant
      // because the first real step will restamp companion models.
      const seedMethod = this._timestep.currentMethod;
      for (const el of elements) {
        if (el.updateCompanion) {
          el.updateCompanion(0, seedMethod, this._voltages);
        }
      }
    }

    return result;
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
    if (nodeId <= 0) return 0;
    const idx = nodeId - 1;
    if (idx >= this._voltages.length) return 0;
    return this._voltages[idx];
  }

  setNodeVoltage(nodeId: number, voltage: number): void {
    if (nodeId <= 0) return;
    const idx = nodeId - 1;
    if (idx >= this._voltages.length) return;
    this._voltages[idx] = voltage;
    this._prevVoltages[idx] = voltage;
  }

  /**
   * Return the current through MNA branch row `branchId`.
   *
   * Branch rows are stored after node voltages in the solution vector.
   * `branchId` is 0-based within the branch block.
   */
  getBranchCurrent(branchId: number): number {
    if (!this._compiled) return 0;
    const offset = this._compiled.nodeCount + branchId;
    if (offset < 0 || offset >= this._voltages.length) return 0;
    return this._voltages[offset];
  }

  /**
   * Return the instantaneous current through analog element `elementId`.
   *
   * Returns the first pin current from getPinCurrents, which is the
   * conventional current flowing into the element at its first pin.
   */
  getElementCurrent(elementId: number): number {
    const el = this._compiled?.elements[elementId];
    if (!el) return 0;
    return el.getPinCurrents(this._voltages)[0];
  }

  /**
   * Return per-pin currents for analog element `elementId`.
   */
  getElementPinCurrents(elementId: number): number[] {
    const el = this._compiled?.elements[elementId];
    if (!el) return [];
    return el.getPinCurrents(this._voltages);
  }

  /**
   * Return the instantaneous power dissipated by analog element `elementId`.
   *
   * Computed as sum(V_pin_i × I_into_i) across all pins.
   */
  getElementPower(elementId: number): number {
    const el = this._compiled?.elements[elementId];
    if (!el) return 0;
    const currents = el.getPinCurrents(this._voltages);
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
    this._params = { ...this._params, ...params };
    this._timestep = new TimestepController(this._params);
    this._seedBreakpoints();
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
  ) => void) | null = null;

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
