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
import type { ConvergenceTrace } from "./diagnostics.js";
import { solveDcOperatingPoint } from "./dc-operating-point.js";
import { newtonRaphson } from "./newton-raphson.js";
import type { AnalogElement } from "./element.js";
import type { ConcreteCompiledAnalogCircuit as CompiledWithBridges } from "./compiled-analog-circuit.js";
import type { StatePool } from "./state-pool.js";

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

  // -------------------------------------------------------------------------
  // State vectors (allocated in init, sized to matrixSize)
  // -------------------------------------------------------------------------
  private _voltages: Float64Array = new Float64Array(0);
  private _prevVoltages: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Hoisted working buffers — allocated once in init() and reused every step.
  //
  // `_stateCheckpoint`: persistent scratch buffer for snapshotting state0
  // before each NR solve. Sized to `statePool.totalSlots`; null when the
  // circuit has no state pool.
  //
  // `_nrVoltages` and `_nrPrevVoltages`: per-iteration voltage arrays for
  // the NR solver. Sized to `matrixSize`.
  // -------------------------------------------------------------------------
  private _stateCheckpoint: Float64Array | null = null;
  private _nrVoltages: Float64Array = new Float64Array(0);
  private _nrPrevVoltages: Float64Array = new Float64Array(0);

  // -------------------------------------------------------------------------
  // Compiled circuit reference
  // -------------------------------------------------------------------------
  private _compiled: ConcreteCompiledAnalogCircuit | null = null;

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

    const { matrixSize, elements } = compiled;

    this._voltages = new Float64Array(matrixSize);
    this._prevVoltages = new Float64Array(matrixSize);

    // Hoisted NR working buffers (see field declarations for rationale).
    this._nrVoltages = new Float64Array(matrixSize);
    this._nrPrevVoltages = new Float64Array(matrixSize);

    // Hoisted state-pool checkpoint buffer — sized to pool slot count when a pool is present.
    const pool = (compiled as CompiledWithBridges).statePool ?? null;
    this._stateCheckpoint = pool ? new Float64Array(pool.totalSlots) : null;

    this._solver = new SparseSolver();
    this._timestep = new TimestepController(this._params);
    this._history = new HistoryStore(elements.length);
    this._diagnostics = new DiagnosticCollector();

    this._simTime = 0;
    this._lastDt = 0;

    // Bind pool-backed elements to the compiled circuit's shared state pool.
    //
    // Allocation is the compiler's responsibility (see compiler.ts, the loop
    // that assigns `stateBaseOffset` before constructing `StatePool`). The
    // engine assumes every element with `stateSize > 0` already has a valid
    // offset by the time `init()` is called. It only performs the cheap
    // `initState` binding step — handing the element a reference to the
    // pool so it can cache `this.s0 = pool.state0` and `this.base = offset`.
    //
    // Any element that arrives here with `stateBaseOffset < 0` signals a
    // real upstream bug: a code path that produced a `CompiledAnalogCircuit`
    // without running allocation. We throw rather than paper over it,
    // because a silent fallback reassignment would hide future allocation
    // regressions as numerical wrongness (flat capacitor voltages, etc.)
    // rather than loud failures.
    const cac = compiled as CompiledWithBridges;
    if (cac.statePool) {
      for (const el of elements) {
        if (el.stateSize > 0) {
          if (el.stateBaseOffset < 0) {
            throw new Error(
              `MNAEngine.init(): element with stateSize=${el.stateSize} arrived ` +
              `with stateBaseOffset=-1. Pool-backed elements must have offsets ` +
              `assigned at compile time (see compiler.ts state-pool allocation ` +
              `loop). A circuit produced without running that allocation step ` +
              `is invalid input to the engine.`,
            );
          }
          el.initState?.(cac.statePool);
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
    if (cac?.statePool) cac.statePool.reset();
    this._lastDt = 0;
    this._timestep = new TimestepController(this._params);
    this._diagnostics.clear();
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
    this._stateCheckpoint = null;
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

    const { elements, matrixSize, nodeCount } = this._compiled;
    const params = this._params;

    this._prevVoltages.set(this._voltages);
    const statePool = (this._compiled as CompiledWithBridges).statePool ?? null;
    // Snapshot state0 into the hoisted scratch buffer (memcpy, no allocation).
    // Mirrors the `_prevVoltages.set(_voltages)` pattern one line above.
    if (statePool && this._stateCheckpoint) {
      this._stateCheckpoint.set(statePool.state0);
    }

    let dt = this._timestep.getClampedDt(this._simTime);
    const method = this._timestep.currentMethod;

    // Stamp companion models for reactive elements
    for (const el of elements) {
      if (el.isReactive && el.stampCompanion) {
        el.stampCompanion(dt, method, this._voltages);
      }
    }

    // NR solve with retry on convergence failure
    let nrResult = newtonRaphson({
      solver: this._solver,
      elements,
      matrixSize,
      maxIterations: params.maxIterations,
      reltol: params.reltol,
      abstol: params.abstol,
      initialGuess: this._voltages,
      diagnostics: this._diagnostics,
      voltagesBuffer: this._nrVoltages,
      prevVoltagesBuffer: this._nrPrevVoltages,
    });

    if (!nrResult.converged) {
      // Retry with progressively halved dt
      let retryDt = dt / 2;
      let recovered = false;

      while (retryDt >= params.minTimeStep) {
        // Restore voltages before retry
        this._voltages.set(this._prevVoltages);
        if (statePool && this._stateCheckpoint) {
          statePool.state0.set(this._stateCheckpoint);
        }

        // Restamp companion models with reduced dt
        for (const el of elements) {
          if (el.isReactive && el.stampCompanion) {
            el.stampCompanion(retryDt, method, this._voltages);
          }
        }

        nrResult = newtonRaphson({
          solver: this._solver,
          elements,
          matrixSize,
          maxIterations: params.maxIterations,
          reltol: params.reltol,
          abstol: params.abstol,
          initialGuess: this._voltages,
          diagnostics: this._diagnostics,
          voltagesBuffer: this._nrVoltages,
          prevVoltagesBuffer: this._nrPrevVoltages,
        });

        if (nrResult.converged) {
          dt = retryDt;
          this._timestep.currentDt = retryDt;
          recovered = true;
          break;
        }

        retryDt /= 2;
      }

      if (!recovered) {
        // Identify the element with the largest voltage change from last trace
        const trace = nrResult.trace;
        const blameElement =
          trace.length > 0 ? trace[trace.length - 1].largestChangeElement : -1;
        const involvedElements = blameElement >= 0 ? [blameElement] : [];

        this._diagnostics.emit(
          makeDiagnostic("convergence-failed", "error", "Transient NR failed to converge", {
            explanation:
              "Newton-Raphson iteration failed to converge after halving the timestep to the " +
              "minimum allowed value. Check the circuit for instability or stiff elements.",
            involvedElements,
            simTime: this._simTime,
          }),
        );
        this._transitionState(EngineState.ERROR);
        return;
      }
    }

    // Accept the NR solution into _voltages
    this._voltages.set(nrResult.voltages);

    // LTE-based timestep rejection.
    //
    // `worstRatio` is the largest per-element (LTE / local_tolerance) ratio
    // across all reactive elements, using the ngspice composite tolerance
    // (trtol · (reltol · |Q_ref| + chargeTol)). A ratio > 1 means at least
    // one element blew its tolerance and the step must be rejected.
    const { newDt, worstRatio } = this._timestep.computeNewDt(elements, this._history, this._simTime, dt);

    if (this._timestep.shouldReject(worstRatio)) {
      // Restore voltages and state to start of this step
      this._voltages.set(this._prevVoltages);
      if (statePool && this._stateCheckpoint) {
        statePool.state0.set(this._stateCheckpoint);
      }
      const rejectedDt = this._timestep.reject();

      // Retry NR with progressively halved dt until convergence or minTimeStep.
      // Mirrors the NR failure retry loop so LTE rejection has the same
      // robustness as a direct NR failure.
      let lteRetryDt = rejectedDt;
      let lteRecovered = false;
      let lteLastTrace: ConvergenceTrace[] = [];

      while (lteRetryDt >= params.minTimeStep) {
        // Restamp companion with current retry dt
        for (const el of elements) {
          if (el.isReactive && el.stampCompanion) {
            el.stampCompanion(lteRetryDt, method, this._voltages);
          }
        }

        const retryResult = newtonRaphson({
          solver: this._solver,
          elements,
          matrixSize,
          maxIterations: params.maxIterations,
          reltol: params.reltol,
          abstol: params.abstol,
          initialGuess: this._voltages,
          diagnostics: this._diagnostics,
          voltagesBuffer: this._nrVoltages,
          prevVoltagesBuffer: this._nrPrevVoltages,
        });
        lteLastTrace = retryResult.trace;

        if (retryResult.converged) {
          this._voltages.set(retryResult.voltages);
          dt = lteRetryDt;
          this._timestep.currentDt = lteRetryDt;
          lteRecovered = true;
          break;
        }

        // Not converged — restore and halve
        this._voltages.set(this._prevVoltages);
        if (statePool && this._stateCheckpoint) {
          statePool.state0.set(this._stateCheckpoint);
        }
        lteRetryDt /= 2;
      }

      if (!lteRecovered) {
        const blameElement =
          lteLastTrace.length > 0 ? lteLastTrace[lteLastTrace.length - 1].largestChangeElement : -1;
        const involvedElements = blameElement >= 0 ? [blameElement] : [];
        this._diagnostics.emit(
          makeDiagnostic("convergence-failed", "error", "Transient NR failed on LTE retry", {
            explanation:
              "Newton-Raphson iteration failed to converge after LTE-triggered timestep reduction. " +
              "Check the circuit for instability or stiff elements.",
            involvedElements,
            simTime: this._simTime,
          }),
        );
        this._transitionState(EngineState.ERROR);
        return;
      }
    }

    // Accept the timestep
    if (statePool) statePool.acceptTimestep();
    this._simTime += dt;
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

    const { elements, matrixSize } = this._compiled;
    this._diagnostics.clear();

    const cac = this._compiled as CompiledWithBridges;
    if (cac.statePool) cac.statePool.reset();

    const result = solveDcOperatingPoint({
      solver: this._solver,
      elements,
      matrixSize,
      params: this._params,
      diagnostics: this._diagnostics,
    });

    if (result.converged) {
      this._voltages.set(result.nodeVoltages);
      if (cac.statePool) {
        cac.statePool.state1.set(cac.statePool.state0);
        cac.statePool.state2.set(cac.statePool.state0);
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
