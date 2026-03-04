/**
 * DigitalEngine — single implementation of SimulationEngine.
 *
 * Three evaluation modes (level, timed, microstep) share the same flat
 * Uint32Array signal storage and compiled circuit representation.
 *
 * Level-by-level mode (default):
 *   Evaluate components in topological order. Non-feedback groups: one-pass
 *   sweep via function table. Feedback SCCs: iterate until stable or
 *   oscillation limit reached.
 *
 * Timed mode:
 *   Each component has a configurable propagation delay. Outputs are
 *   scheduled at currentTime + delay via a timing wheel. Glitches are visible.
 *
 * Micro-step mode:
 *   Evaluate one component at a time, report which component fired.
 *
 * Java reference: de.neemann.digital.core.Model
 */

import type {
  SimulationEngine,
  CompiledCircuit,
  EngineChangeListener,
  MeasurementObserver,
} from "@/core/engine-interface";
import { EngineState } from "@/core/engine-interface";
import { BitVector, bitVectorToRaw, rawToBitVector } from "@/core/signal";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";
import type { CircuitElement } from "@/core/element";
import type { Wire } from "@/core/circuit";
import type { EvaluationMode } from "./evaluation-mode.js";

// ---------------------------------------------------------------------------
// EvaluationGroup — one group in the topological evaluation order
// ---------------------------------------------------------------------------

/**
 * A group of component indices to be evaluated together.
 *
 * Non-feedback groups (isFeedback=false) are swept once per step.
 * Feedback groups (isFeedback=true, typically SCCs of size >1) are
 * iterated until all outputs stabilise or the oscillation limit is reached.
 */
export interface EvaluationGroup {
  /** Component indices belonging to this group, in evaluation order. */
  readonly componentIndices: Uint32Array;
  /** True when this group forms a combinational feedback loop (SCC). */
  readonly isFeedback: boolean;
}

// ---------------------------------------------------------------------------
// ConcreteCompiledCircuit — the engine-internal view of a compiled circuit
// ---------------------------------------------------------------------------

/**
 * Extended CompiledCircuit with all fields the engine needs.
 *
 * The opaque CompiledCircuit interface (from Phase 1) only exposes netCount
 * and componentCount. The compiler (task 3.2.1) produces objects that
 * implement this interface. DigitalEngine narrows to it internally via
 * isConcreteCompiledCircuit().
 */
export interface ConcreteCompiledCircuit extends CompiledCircuit {
  /** Type ID per component slot (index into executeFns). */
  readonly typeIds: Uint8Array;
  /** Function table indexed by type ID. */
  readonly executeFns: ExecuteFunction[];
  /** Wiring descriptor providing input/output net offsets per component. */
  readonly layout: ComponentLayout;
  /** Topologically sorted evaluation groups. */
  readonly evaluationOrder: EvaluationGroup[];
  /** Indices of sequential elements (flip-flops etc.) for clock-edge evaluation. */
  readonly sequentialComponents: Uint32Array;
  /** Bit width per net for BitVector construction. */
  readonly netWidths: Uint8Array;
  /** Pre-allocated snapshot buffer for synchronized SCC evaluation. */
  readonly sccSnapshotBuffer: Uint32Array;
  /** Per-component gate delay in nanoseconds (for timed mode). */
  readonly delays: Uint32Array;
  /** Maps component index to its CircuitElement for debugging and micro-step UI. */
  readonly componentToElement: Map<number, CircuitElement>;
  /** Maps label string to net ID for facade's label-based signal access. */
  readonly labelToNetId: Map<string, number>;
  /** Maps Wire instance to net ID for the renderer's wire coloring. */
  readonly wireToNetId: Map<Wire, number>;
}

function isConcreteCompiledCircuit(c: CompiledCircuit): c is ConcreteCompiledCircuit {
  return (
    "typeIds" in c &&
    "executeFns" in c &&
    "layout" in c &&
    "evaluationOrder" in c
  );
}

// ---------------------------------------------------------------------------
// MicrostepCursor — tracks position in micro-step evaluation
// ---------------------------------------------------------------------------

interface MicrostepCursor {
  groupIndex: number;
  indexWithinGroup: number;
}

// ---------------------------------------------------------------------------
// TimedEvent — an event pending in timed simulation
// ---------------------------------------------------------------------------

interface TimedEvent {
  netId: number;
  value: number;
  highZ: number;
  timestamp: bigint;
}

// ---------------------------------------------------------------------------
// Maximum feedback iterations before declaring oscillation
// ---------------------------------------------------------------------------

const MAX_FEEDBACK_ITERATIONS = 1000;

// ---------------------------------------------------------------------------
// DigitalEngine
// ---------------------------------------------------------------------------

/**
 * Single engine implementation for all three simulation modes.
 *
 * After init(), the engine holds the signal state array and evaluates
 * components according to the selected mode. The compiled circuit supplies
 * the function table, wiring, and evaluation order.
 */
export class DigitalEngine implements SimulationEngine {
  private _mode: EvaluationMode;
  private _engineState: EngineState = EngineState.STOPPED;

  // Signal arrays — owned by the engine
  private _values: Uint32Array = new Uint32Array(0);
  private _highZs: Uint32Array = new Uint32Array(0);

  // Per-net undefined flags — 1 = UNDEFINED, 0 = defined.
  // Set by _initSignalsUndefined, cleared when a component writes a net.
  private _undefinedFlags: Uint8Array = new Uint8Array(0);

  // Compiled circuit — set by init()
  private _compiled: ConcreteCompiledCircuit | null = null;

  // Listeners and observers
  private readonly _changeListeners: Set<EngineChangeListener> = new Set();
  private readonly _measurementObservers: Set<MeasurementObserver> = new Set();

  // Step counter for measurement observers
  private _stepCount = 0;

  // Micro-step cursor
  private _microstepCursor: MicrostepCursor = { groupIndex: 0, indexWithinGroup: 0 };
  private _lastEvaluatedComponent: { index: number; typeId: string } | undefined = undefined;

  // Timed mode state
  private _currentTime = 0n;
  private _pendingTimedEvents: TimedEvent[] = [];

  // Continuous run handle (requestAnimationFrame id or -1)
  private _rafHandle = -1;

  constructor(mode: EvaluationMode = "level") {
    this._mode = mode;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(circuit: CompiledCircuit): void {
    if (!isConcreteCompiledCircuit(circuit)) {
      // Accept opaque CompiledCircuit for test/mock scenarios — build minimal
      // concrete structure so the engine can at least allocate signal arrays.
      this._values = new Uint32Array(circuit.netCount);
      this._highZs = new Uint32Array(circuit.netCount);
      this._compiled = null;
      this._initSignalsUndefined(circuit.netCount);
      this._engineState = EngineState.STOPPED;
      this._stepCount = 0;
      this._resetMicrostepCursor();
      this._currentTime = 0n;
      this._pendingTimedEvents = [];
      return;
    }

    this._compiled = circuit;
    this._values = new Uint32Array(circuit.netCount);
    this._highZs = new Uint32Array(circuit.netCount);
    this._initSignalsUndefined(circuit.netCount);
    this._engineState = EngineState.STOPPED;
    this._stepCount = 0;
    this._resetMicrostepCursor();
    this._currentTime = 0n;
    this._pendingTimedEvents = [];
  }

  reset(): void {
    const netCount = this._values.length;
    this._initSignalsUndefined(netCount);
    this._stepCount = 0;
    this._resetMicrostepCursor();
    this._currentTime = 0n;
    this._pendingTimedEvents = [];
    this._setState(EngineState.STOPPED);
  }

  dispose(): void {
    this._stopContinuousRun();
    this._compiled = null;
    this._values = new Uint32Array(0);
    this._highZs = new Uint32Array(0);
    this._changeListeners.clear();
    this._measurementObservers.clear();
    this._setState(EngineState.STOPPED);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  step(): void {
    if (this._compiled === null) return;

    switch (this._mode) {
      case "level":
        this._stepLevel();
        break;
      case "timed":
        this._stepTimed();
        break;
      case "microstep":
        this._stepMicrostep();
        break;
    }

    this._stepCount++;
    this._notifyMeasurementObservers();
  }

  microStep(): void {
    if (this._compiled === null) return;

    if (this._mode === "microstep") {
      this._stepMicrostep();
    } else {
      // Temporarily switch to microstep for a single evaluation, then restore.
      const savedMode = this._mode;
      this._mode = "microstep";
      this._stepMicrostep();
      this._mode = savedMode;
    }

    this._stepCount++;
    this._notifyMeasurementObservers();
  }

  runToBreak(): void {
    if (this._compiled === null) return;

    this._setState(EngineState.RUNNING);
    // Run up to a safety limit to avoid infinite loops in tests
    const MAX_STEPS = 100_000;
    for (let i = 0; i < MAX_STEPS; i++) {
      this.step();
      // Break components would set a flag via their executeFn; for now
      // there is no Break component mechanism — just run one full pass.
      break;
    }
    this._setState(EngineState.STOPPED);
  }

  // -------------------------------------------------------------------------
  // Continuous run
  // -------------------------------------------------------------------------

  start(): void {
    if (this._engineState === EngineState.RUNNING) return;
    this._setState(EngineState.RUNNING);
    this._scheduleContinuousRun();
  }

  stop(): void {
    this._stopContinuousRun();
    if (this._engineState !== EngineState.STOPPED) {
      this._setState(EngineState.PAUSED);
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  getState(): EngineState {
    return this._engineState;
  }

  // -------------------------------------------------------------------------
  // Signal access
  // -------------------------------------------------------------------------

  getSignalRaw(netId: number): number {
    return netId < this._values.length ? (this._values[netId] ?? 0) : 0;
  }

  getSignalValue(netId: number): BitVector {
    if (netId >= this._values.length) {
      return BitVector.allUndefined(1);
    }
    const width = this._netWidthFor(netId);
    if (this._undefinedFlags[netId]) {
      return BitVector.allUndefined(width);
    }
    return rawToBitVector(this._values, this._highZs, netId, width);
  }

  setSignalValue(netId: number, value: BitVector): void {
    if (netId < this._values.length) {
      bitVectorToRaw(value, this._values, this._highZs, netId);
      this._undefinedFlags[netId] = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  addChangeListener(listener: EngineChangeListener): void {
    this._changeListeners.add(listener);
  }

  removeChangeListener(listener: EngineChangeListener): void {
    this._changeListeners.delete(listener);
  }

  addMeasurementObserver(observer: MeasurementObserver): void {
    this._measurementObservers.add(observer);
  }

  removeMeasurementObserver(observer: MeasurementObserver): void {
    this._measurementObservers.delete(observer);
  }

  // -------------------------------------------------------------------------
  // Extended API (beyond SimulationEngine interface)
  // -------------------------------------------------------------------------

  /**
   * Returns the most recently evaluated component during micro-step mode,
   * or undefined if no evaluation has occurred yet.
   */
  getLastEvaluatedComponent(): { index: number; typeId: string } | undefined {
    return this._lastEvaluatedComponent;
  }

  /**
   * Switch evaluation mode at runtime.
   * Resets timing state when switching to/from timed mode.
   */
  setMode(mode: EvaluationMode): void {
    const changingTimedMode = this._mode === "timed" || mode === "timed";
    this._mode = mode;
    if (changingTimedMode) {
      this._currentTime = 0n;
      this._pendingTimedEvents = [];
    }
    this._resetMicrostepCursor();
  }

  // -------------------------------------------------------------------------
  // Private: signal helpers
  // -------------------------------------------------------------------------

  private _initSignalsUndefined(netCount: number): void {
    // UNDEFINED: value=0, highZ=0xFFFFFFFF (all bits high-Z)
    this._values.fill(0);
    this._highZs.fill(0xffffffff);
    this._undefinedFlags = new Uint8Array(netCount);
    this._undefinedFlags.fill(1);
  }

  private _netWidthFor(netId: number): number {
    if (this._compiled !== null && netId < this._compiled.netWidths.length) {
      return this._compiled.netWidths[netId] ?? 1;
    }
    return 1;
  }

  // -------------------------------------------------------------------------
  // Private: level-by-level evaluation
  // -------------------------------------------------------------------------

  private _stepLevel(): void {
    const compiled = this._compiled!;
    const { executeFns, typeIds, layout, evaluationOrder } = compiled;
    const state = this._values;

    for (let g = 0; g < evaluationOrder.length; g++) {
      const group = evaluationOrder[g]!;
      if (group.isFeedback) {
        this._evaluateFeedbackGroup(group, executeFns, typeIds, layout, state);
      } else {
        this._evaluateGroupOnce(group, executeFns, typeIds, layout, state);
      }
    }
  }

  private _evaluateGroupOnce(
    group: EvaluationGroup,
    executeFns: ExecuteFunction[],
    typeIds: Uint8Array,
    layout: ComponentLayout,
    state: Uint32Array,
  ): void {
    const indices = group.componentIndices;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]!;
      const typeId = typeIds[idx]!;
      executeFns[typeId]!(idx, state, layout);
    }
  }

  private _evaluateFeedbackGroup(
    group: EvaluationGroup,
    executeFns: ExecuteFunction[],
    typeIds: Uint8Array,
    layout: ComponentLayout,
    state: Uint32Array,
  ): void {
    const indices = group.componentIndices;

    // Collect all output net IDs touched by this SCC for change detection
    const outputNets = this._collectOutputNets(indices, layout);

    for (let iter = 0; iter < MAX_FEEDBACK_ITERATIONS; iter++) {
      // Snapshot current output values for change detection
      const snapshot = new Uint32Array(outputNets.length);
      for (let n = 0; n < outputNets.length; n++) {
        snapshot[n] = state[outputNets[n]!]!;
      }

      // Evaluate all components in the group
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]!;
        const typeId = typeIds[idx]!;
        executeFns[typeId]!(idx, state, layout);
      }

      // Check if outputs changed
      let stable = true;
      for (let n = 0; n < outputNets.length; n++) {
        if (state[outputNets[n]!] !== snapshot[n]) {
          stable = false;
          break;
        }
      }

      if (stable) return;
    }

    // Oscillation detected — leave state as-is (engine remains in ERROR-capable state)
  }

  private _collectOutputNets(indices: Uint32Array, layout: ComponentLayout): number[] {
    const nets: number[] = [];
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]!;
      const outCount = layout.outputCount(idx);
      const outOffset = layout.outputOffset(idx);
      for (let o = 0; o < outCount; o++) {
        nets.push(outOffset + o);
      }
    }
    return nets;
  }

  // -------------------------------------------------------------------------
  // Private: timed evaluation
  // -------------------------------------------------------------------------

  private _stepTimed(): void {
    const compiled = this._compiled!;
    const { executeFns, typeIds, layout, delays } = compiled;
    const state = this._values;

    // Advance time by default clock period (use smallest delay as tick unit)
    const tick = 10n; // 10ns default clock period
    const targetTime = this._currentTime + tick;

    // Process all events up to targetTime
    const toProcess = this._pendingTimedEvents.filter(
      (ev) => ev.timestamp <= targetTime,
    );
    toProcess.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

    for (const ev of toProcess) {
      state[ev.netId] = ev.value;
      this._highZs[ev.netId] = ev.highZ;
    }

    // Remove processed events
    this._pendingTimedEvents = this._pendingTimedEvents.filter(
      (ev) => ev.timestamp > targetTime,
    );

    // Evaluate all components and schedule output changes
    for (let g = 0; g < compiled.evaluationOrder.length; g++) {
      const group = compiled.evaluationOrder[g]!;
      const indices = group.componentIndices;

      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]!;
        const typeId = typeIds[idx]!;

        // Snapshot outputs before evaluation
        const outCount = layout.outputCount(idx);
        const outOffset = layout.outputOffset(idx);
        const beforeValues = new Uint32Array(outCount);
        const beforeHighZs = new Uint32Array(outCount);
        for (let o = 0; o < outCount; o++) {
          beforeValues[o] = state[outOffset + o]!;
          beforeHighZs[o] = this._highZs[outOffset + o]!;
        }

        executeFns[typeId]!(idx, state, layout);

        // Schedule events for changed outputs
        const delay = BigInt(delays[idx] ?? 10);
        const eventTime = targetTime + delay;

        for (let o = 0; o < outCount; o++) {
          const netId = outOffset + o;
          if (
            state[netId] !== beforeValues[o] ||
            this._highZs[netId] !== beforeHighZs[o]
          ) {
            // Replace existing event for same net or add new one
            const existing = this._pendingTimedEvents.findIndex(
              (ev) => ev.netId === netId,
            );
            const event: TimedEvent = {
              netId,
              value: state[netId]!,
              highZ: this._highZs[netId]!,
              timestamp: eventTime,
            };
            if (existing >= 0) {
              this._pendingTimedEvents[existing] = event;
            } else {
              this._pendingTimedEvents.push(event);
            }
          }
        }
      }
    }

    this._currentTime = targetTime;
  }

  // -------------------------------------------------------------------------
  // Private: micro-step evaluation
  // -------------------------------------------------------------------------

  private _stepMicrostep(): void {
    const compiled = this._compiled!;
    const { executeFns, typeIds, layout, evaluationOrder } = compiled;
    const state = this._values;

    // Find the next component to evaluate
    while (this._microstepCursor.groupIndex < evaluationOrder.length) {
      const group = evaluationOrder[this._microstepCursor.groupIndex]!;
      const indices = group.componentIndices;

      if (this._microstepCursor.indexWithinGroup < indices.length) {
        const idx = indices[this._microstepCursor.indexWithinGroup]!;
        const typeId = typeIds[idx]!;

        executeFns[typeId]!(idx, state, layout);

        this._lastEvaluatedComponent = { index: idx, typeId: typeId.toString() };

        this._microstepCursor.indexWithinGroup++;
        return;
      }

      // Move to next group
      this._microstepCursor.groupIndex++;
      this._microstepCursor.indexWithinGroup = 0;
    }

    // All groups exhausted — wrap around for next full pass
    this._resetMicrostepCursor();
  }

  private _resetMicrostepCursor(): void {
    this._microstepCursor = { groupIndex: 0, indexWithinGroup: 0 };
  }

  // -------------------------------------------------------------------------
  // Private: continuous run
  // -------------------------------------------------------------------------

  private _scheduleContinuousRun(): void {
    // In a browser environment, use requestAnimationFrame. In Node/test
    // environments, use setImmediate/setTimeout as fallback.
    if (typeof requestAnimationFrame !== "undefined") {
      const tick = (): void => {
        if (this._engineState !== EngineState.RUNNING) return;
        this.step();
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    } else {
      // Headless: run one step and schedule next via setTimeout(0)
      const tick = (): void => {
        if (this._engineState !== EngineState.RUNNING) return;
        this.step();
        this._rafHandle = setTimeout(tick, 0) as unknown as number;
      };
      this._rafHandle = setTimeout(tick, 0) as unknown as number;
    }
  }

  private _stopContinuousRun(): void {
    if (this._rafHandle !== -1) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this._rafHandle);
      } else {
        clearTimeout(this._rafHandle);
      }
      this._rafHandle = -1;
    }
  }

  // -------------------------------------------------------------------------
  // Private: state management
  // -------------------------------------------------------------------------

  private _setState(newState: EngineState): void {
    this._engineState = newState;
    for (const listener of this._changeListeners) {
      listener(newState);
    }
  }

  // -------------------------------------------------------------------------
  // Private: measurement observers
  // -------------------------------------------------------------------------

  private _notifyMeasurementObservers(): void {
    for (const observer of this._measurementObservers) {
      observer.onStep(this._stepCount);
    }
  }
}
