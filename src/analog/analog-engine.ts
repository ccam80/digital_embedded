/**
 * MNAEngine — the concrete AnalogEngine implementation.
 *
 * Orchestrates SparseSolver, MNAAssembler, TimestepController, HistoryStore,
 * DiagnosticCollector, and the DC / transient solver functions into a working
 * analog simulator behind the AnalogEngine interface.
 */

import type { CompiledCircuit, EngineChangeListener, MeasurementObserver } from "../core/engine-interface.js";
import { EngineState } from "../core/engine-interface.js";
import type {
  AnalogEngine,
  DcOpResult,
  SolverDiagnostic,
  SimulationParams,
} from "../core/analog-engine-interface.js";
import { DEFAULT_SIMULATION_PARAMS } from "../core/analog-engine-interface.js";
import { AcAnalysis } from "./ac-analysis.js";
import type { AcParams, AcResult } from "./ac-analysis.js";
import { SparseSolver } from "./sparse-solver.js";
import { MNAAssembler } from "./mna-assembler.js";
import { TimestepController } from "./timestep.js";
import { HistoryStore } from "./integration.js";
import { DiagnosticCollector, makeDiagnostic } from "./diagnostics.js";
import { solveDcOperatingPoint } from "./dc-operating-point.js";
import { newtonRaphson } from "./newton-raphson.js";
import type { AnalogElement } from "./element.js";
import { MixedSignalCoordinator } from "./mixed-signal-coordinator.js";
import type { ConcreteCompiledAnalogCircuit as CompiledWithBridges } from "./compiled-analog-circuit.js";

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
  private _assembler: MNAAssembler = new MNAAssembler(this._solver);
  private _timestep: TimestepController = new TimestepController(DEFAULT_SIMULATION_PARAMS);
  private _history: HistoryStore = new HistoryStore(0);
  private _diagnostics: DiagnosticCollector = new DiagnosticCollector();

  // -------------------------------------------------------------------------
  // State vectors (allocated in init, sized to matrixSize)
  // -------------------------------------------------------------------------
  private _voltages: Float64Array = new Float64Array(0);
  private _prevVoltages: Float64Array = new Float64Array(0);

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
  // Mixed-signal coordinator (null when no bridge instances present)
  // -------------------------------------------------------------------------
  private _coordinator: MixedSignalCoordinator | null = null;

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

    this._solver = new SparseSolver();
    this._assembler = new MNAAssembler(this._solver);
    this._timestep = new TimestepController(this._params);
    this._history = new HistoryStore(elements.length);
    this._diagnostics = new DiagnosticCollector();

    this._simTime = 0;
    this._lastDt = 0;

    // Create coordinator if the compiled circuit has bridge instances
    const compiledWithBridges = circuit as CompiledWithBridges;
    if (
      compiledWithBridges.bridges !== undefined &&
      compiledWithBridges.bridges.length > 0
    ) {
      this._coordinator = new MixedSignalCoordinator(this, compiledWithBridges.bridges);
      this._coordinator.setDiagnosticCollector(this._diagnostics);
      this._coordinator.init();
    } else {
      this._coordinator = null;
    }

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
    this._lastDt = 0;
    this._timestep = new TimestepController(this._params);
    this._diagnostics.clear();
    if (this._coordinator !== null) {
      this._coordinator.reset();
    }
    this._stepCount = 0;
    for (const obs of this._measurementObservers) {
      obs.onReset();
    }
    this._transitionState(EngineState.STOPPED);
  }

  /** Release all resources. Engine must not be used after dispose(). */
  dispose(): void {
    if (this._coordinator !== null) {
      this._coordinator.dispose();
      this._coordinator = null;
    }
    this._compiled = null;
    this._voltages = new Float64Array(0);
    this._prevVoltages = new Float64Array(0);
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

    // Synchronize digital inner engines before starting the NR solve
    if (this._coordinator !== null) {
      this._coordinator.syncBeforeAnalogStep(this._voltages);
    }

    let dt = this._timestep.currentDt;
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
    });

    if (!nrResult.converged) {
      // Retry with progressively halved dt
      let retryDt = dt / 2;
      let recovered = false;

      while (retryDt >= params.minTimeStep) {
        // Restore voltages before retry
        this._voltages.set(this._prevVoltages);

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

    // LTE-based timestep rejection
    const newDt = this._timestep.computeNewDt(elements, this._history, this._simTime);
    const maxError = this._computeMaxLteError(elements, dt);
    const r = maxError > 0 ? params.chargeTol / maxError : Infinity;

    if (this._timestep.shouldReject(r)) {
      // Restore and retry with halved dt
      this._voltages.set(this._prevVoltages);
      const rejectedDt = this._timestep.reject();

      // Restamp companion with halved dt and retry NR
      for (const el of elements) {
        if (el.isReactive && el.stampCompanion) {
          el.stampCompanion(rejectedDt, method, this._voltages);
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
      });

      if (retryResult.converged) {
        this._voltages.set(retryResult.voltages);
        dt = rejectedDt;
      }
    }

    // Accept the timestep
    this._simTime += dt;
    const cac = this._compiled as CompiledWithBridges | undefined;
    if (cac?.timeRef) cac.timeRef.value = this._simTime;
    this._lastDt = dt;

    // Push history for BDF-2
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.isReactive && el.nodeIndices.length >= 2) {
        const nA = el.nodeIndices[0];
        const nB = el.nodeIndices[1];
        const vA = nA > 0 && nA - 1 < nodeCount ? this._voltages[nA - 1] : 0;
        const vB = nB > 0 && nB - 1 < nodeCount ? this._voltages[nB - 1] : 0;
        this._history.push(i, vA - vB);
      }
    }

    // Advance timestep controller state
    this._timestep.currentDt = newDt;
    this._timestep.accept(this._simTime);
    this._timestep.checkMethodSwitch(elements, this._history);

    // Update non-MNA state for elements that track it
    for (const el of elements) {
      if (el.updateState) {
        el.updateState(dt, this._voltages);
      }
    }

    // Check for threshold crossings and re-evaluate digital engines if needed
    if (this._coordinator !== null) {
      this._coordinator.syncAfterAnalogStep(this._voltages);
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

    const result = solveDcOperatingPoint({
      solver: this._solver,
      elements,
      matrixSize,
      params: this._params,
      diagnostics: this._diagnostics,
    });

    if (result.converged) {
      this._voltages.set(result.nodeVoltages);
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
   * For elements with a branch row (voltage sources, inductors), returns the
   * branch current directly. For resistive elements, computes V/R from node
   * voltages. For nonlinear elements, returns the Norton equivalent current
   * at the current operating point.
   */
  getElementCurrent(elementId: number): number {
    if (!this._compiled) return 0;
    const el = this._compiled.elements[elementId];
    if (!el) return 0;

    // If the element has a branch current row, read it directly from the
    // solution vector. branchIndex is an absolute solver row index
    // (already includes the nodeCount offset), so read directly.
    if (el.branchIndex >= 0) {
      if (el.branchIndex < this._voltages.length) {
        return this._voltages[el.branchIndex];
      }
      return 0;
    }

    // Delegate to the element's getCurrent() if it implements it
    if (el.getCurrent !== undefined) {
      return el.getCurrent(this._voltages);
    }

    return 0;
  }

  /**
   * Return the instantaneous power dissipated by analog element `elementId`.
   *
   * Computed as V_terminals × I_element.
   */
  getElementPower(elementId: number): number {
    if (!this._compiled) return 0;
    const el = this._compiled.elements[elementId];
    if (!el) return 0;

    const nA = el.nodeIndices[0] ?? 0;
    const nB = el.nodeIndices[1] ?? 0;

    const vA = this.getNodeVoltage(nA);
    const vB = this.getNodeVoltage(nB);
    const vAB = vA - vB;

    const current = this.getElementCurrent(elementId);
    return vAB * current;
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
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Diagnostics
  // -------------------------------------------------------------------------

  /** Register a callback to receive SolverDiagnostic records. */
  onDiagnostic(callback: (diag: SolverDiagnostic) => void): void {
    this._diagnostics.onDiagnostic(callback);
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Breakpoints
  // -------------------------------------------------------------------------

  /** Register a simulation time at which the timestep must land exactly. */
  addBreakpoint(time: number): void {
    this._timestep.addBreakpoint(time);
  }

  /** Remove all registered breakpoints. */
  clearBreakpoints(): void {
    this._timestep.clearBreakpoints();
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
   * Compute the maximum LTE error across all reactive elements.
   *
   * Returns 0 when there are no reactive elements or none implement getLteEstimate.
   */
  private _computeMaxLteError(elements: readonly AnalogElement[], dt: number): number {
    let maxError = 0;
    for (const el of elements) {
      if (el.isReactive && el.getLteEstimate) {
        const { truncationError } = el.getLteEstimate(dt);
        if (truncationError > maxError) maxError = truncationError;
      }
    }
    return maxError;
  }
}
