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
 */

import type {
  SimulationEngine,
  CompiledCircuit,
  EngineChangeListener,
  MeasurementObserver,
  SnapshotId,
} from "@/core/engine-interface";
import { EngineState } from "@/core/engine-interface";
import { BitVector, bitVectorToRaw, rawToBitVector } from "@/core/signal";
import type { ExecuteFunction, ComponentLayout } from "@/core/registry";
import type { CircuitElement } from "@/core/element";
import type { Wire } from "@/core/circuit";
import type { EvaluationMode } from "./evaluation-mode.js";
import { initializeCircuit } from "./init-sequence.js";
import type { InitializableEngine } from "./init-sequence.js";
import type { BusResolver } from "./bus-resolution.js";
import { OscillationError } from "@/core/errors.js";
import { OscillationDetector, COLLECTION_STEPS } from "./oscillation.js";

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
  /** Total number of state slots allocated for all components. */
  readonly totalStateSlots: number;
  /** Total signal array size: netCount + totalStateSlots. */
  readonly signalArraySize: number;
  /** Type ID per component slot (index into executeFns). */
  readonly typeIds: Uint8Array;
  /** Function table indexed by type ID. */
  readonly executeFns: ExecuteFunction[];
  /** Sample function table indexed by type ID. Non-null for sequential components. */
  readonly sampleFns: (ExecuteFunction | null)[];
  /** Wiring indirection table mapping layout indices to net IDs. */
  readonly wiringTable: Int32Array;
  /** Wiring descriptor providing input/output wiring-table offsets per component. */
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
  /** Maps "{instanceId}:{pinLabel}" keys to net IDs for pin-level signal access. */
  readonly pinNetMap: Map<string, number>;
  /** Indices of Reset components (if any). Used by init sequence. */
  readonly resetComponentIndices: Uint32Array;
  /** Bus resolver for multi-driver nets, or null if no multi-driver nets. */
  readonly busResolver: BusResolver | null;
}

function isConcreteCompiledCircuit(c: CompiledCircuit): c is ConcreteCompiledCircuit {
  return (
    "typeIds" in c &&
    "executeFns" in c &&
    "layout" in c &&
    "evaluationOrder" in c &&
    "signalArraySize" in c &&
    "wiringTable" in c
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

// Default snapshot memory budget: 512 KB
const DEFAULT_SNAPSHOT_BUDGET = 512 * 1024;

// ---------------------------------------------------------------------------
// EngineSnapshot — one captured state entry in the ring buffer
// ---------------------------------------------------------------------------

interface EngineSnapshot {
  readonly id: SnapshotId;
  readonly values: Uint32Array;
  readonly highZs: Uint32Array;
  readonly undefinedFlags: Uint8Array;
  readonly stepCount: number;
  /** Byte size of this snapshot's data arrays. */
  readonly byteSize: number;
}

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
export class DigitalEngine implements SimulationEngine, InitializableEngine {
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

  // Pre-allocated buffer for init-sequence's evaluateSynchronized (same size as state)
  private _initSnapshotBuffer: Uint32Array = new Uint32Array(0);

  // Oscillation detection for feedback groups
  private _oscillationDetector: OscillationDetector = new OscillationDetector();

  // Snapshot ring buffer
  private _snapshots: EngineSnapshot[] = [];
  private _nextSnapshotId = 0;
  private _snapshotBudget = DEFAULT_SNAPSHOT_BUDGET;
  private _snapshotBytesUsed = 0;

  constructor(mode: EvaluationMode = "level") {
    this._mode = mode;
  }

  // -------------------------------------------------------------------------
  // InitializableEngine getters
  // -------------------------------------------------------------------------

  get state(): Uint32Array {
    return this._values;
  }

  get highZs(): Uint32Array {
    return this._highZs;
  }

  get snapshotBuffer(): Uint32Array {
    return this._initSnapshotBuffer;
  }

  get typeIds(): Uint8Array {
    return this._compiled !== null ? this._compiled.typeIds : new Uint8Array(0);
  }

  get executeFns(): ExecuteFunction[] {
    return this._compiled !== null ? this._compiled.executeFns : [];
  }

  get sampleFns(): (ExecuteFunction | null)[] {
    return this._compiled !== null ? this._compiled.sampleFns : [];
  }

  get layout(): ComponentLayout {
    if (this._compiled !== null) return this._compiled.layout;
    return {
      wiringTable: new Int32Array(0),
      inputCount: () => 0,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 0,
      stateOffset: () => 0,
    };
  }

  get evaluationOrder(): EvaluationGroup[] {
    return this._compiled !== null ? this._compiled.evaluationOrder : [];
  }

  get resetComponentIndices(): Uint32Array {
    return this._compiled !== null ? this._compiled.resetComponentIndices : new Uint32Array(0);
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
    const arraySize = circuit.signalArraySize;
    this._values = new Uint32Array(arraySize);
    this._highZs = new Uint32Array(arraySize);
    this._initSignalsUndefined(circuit.netCount, arraySize);
    this._engineState = EngineState.STOPPED;
    this._stepCount = 0;
    this._resetMicrostepCursor();
    this._currentTime = 0n;
    this._pendingTimedEvents = [];
    this._initSnapshotBuffer = new Uint32Array(arraySize);
    initializeCircuit(this);
  }

  reset(): void {
    const arraySize = this._values.length;
    const netCount = this._compiled !== null ? this._compiled.netCount : arraySize;
    this._initSignalsUndefined(netCount, arraySize);
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

    // Collect indices of all Break components in the circuit.
    const breakIndices: number[] = [];
    for (const [index, element] of this._compiled.componentToElement) {
      if (element.typeId === "Break") {
        breakIndices.push(index);
      }
    }

    const MAX_STEPS = 100_000;
    for (let i = 0; i < MAX_STEPS; i++) {
      this.step();

      // If no Break components exist, one full pass is sufficient.
      if (breakIndices.length === 0) break;

      // Check whether any Break component's input net is asserted.
      for (const componentIndex of breakIndices) {
        const inOff: number = this._compiled.layout.inputOffset(componentIndex);
        const netId = this._compiled.layout.wiringTable[inOff]!;
        if (this._values[netId] !== 0) {
          this._setState(EngineState.STOPPED);
          return;
        }
      }
    }

    this._setState(EngineState.STOPPED);
  }

  // -------------------------------------------------------------------------
  // Continuous run
  // -------------------------------------------------------------------------

  start(): void {
    if (this._engineState === EngineState.RUNNING) return;
    this._setState(EngineState.RUNNING);
    // Note: the caller (app-init) manages the rAF stepping loop externally
    // so it can integrate speed control and render scheduling. The engine
    // only sets state here. _scheduleContinuousRun() is retained for
    // headless/test use via startSelfClocked().
  }

  /**
   * Start a self-clocked continuous run loop (headless/test use).
   * In browser, prefer calling start() + managing the rAF loop externally.
   */
  startSelfClocked(): void {
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
  // Snapshot API
  // -------------------------------------------------------------------------

  saveSnapshot(): SnapshotId {
    const id = this._nextSnapshotId++;
    const values = this._values.slice();
    const highZs = this._highZs.slice();
    const undefinedFlags = this._undefinedFlags.slice();
    const byteSize =
      values.byteLength + highZs.byteLength + undefinedFlags.byteLength;

    const snapshot: EngineSnapshot = {
      id,
      values,
      highZs,
      undefinedFlags,
      stepCount: this._stepCount,
      byteSize,
    };

    // Evict oldest snapshots until adding this one fits within budget
    while (
      this._snapshots.length > 0 &&
      this._snapshotBytesUsed + byteSize > this._snapshotBudget
    ) {
      const evicted = this._snapshots.shift()!;
      this._snapshotBytesUsed -= evicted.byteSize;
    }

    this._snapshots.push(snapshot);
    this._snapshotBytesUsed += byteSize;
    return id;
  }

  restoreSnapshot(id: SnapshotId): void {
    const snapshot = this._snapshots.find((s) => s.id === id);
    if (snapshot === undefined) {
      throw new Error(`Snapshot ${id} not found — it may have been evicted or never saved`);
    }
    this._values.set(snapshot.values);
    this._highZs.set(snapshot.highZs);
    this._undefinedFlags.set(snapshot.undefinedFlags);
    this._stepCount = snapshot.stepCount;
    this._setState(EngineState.PAUSED);
  }

  getSnapshotCount(): number {
    return this._snapshots.length;
  }

  clearSnapshots(): void {
    this._snapshots = [];
    this._snapshotBytesUsed = 0;
  }

  setSnapshotBudget(bytes: number): void {
    this._snapshotBudget = bytes;
    // Evict oldest snapshots until current usage fits within new budget
    while (
      this._snapshots.length > 0 &&
      this._snapshotBytesUsed > this._snapshotBudget
    ) {
      const evicted = this._snapshots.shift()!;
      this._snapshotBytesUsed -= evicted.byteSize;
    }
  }

  // -------------------------------------------------------------------------
  // Extended API (beyond SimulationEngine interface)
  // -------------------------------------------------------------------------

  /**
   * Returns the raw signal value array owned by the engine.
   *
   * Callers such as ClockManager write clock outputs directly into this
   * array before each engine.step(). The array is sized to
   * `compiled.signalArraySize` (nets + state slots).
   */
  getSignalArray(): Uint32Array {
    return this._values;
  }

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

  private _initSignalsUndefined(netCount: number, arraySize?: number): void {
    const totalSize = arraySize ?? netCount;
    // Net portion: UNDEFINED (value=0, highZ=0xFFFFFFFF)
    this._values.fill(0, 0, netCount);
    this._highZs.fill(0xffffffff, 0, netCount);
    // State portion: initialized to 0
    if (totalSize > netCount) {
      this._values.fill(0, netCount, totalSize);
      this._highZs.fill(0, netCount, totalSize);
    }
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
    const { executeFns, sampleFns, typeIds, layout, evaluationOrder, sequentialComponents, busResolver } = compiled;
    const state = this._values;

    for (let s = 0; s < sequentialComponents.length; s++) {
      const idx = sequentialComponents[s]!;
      const typeId = typeIds[idx]!;
      const sampleFn = sampleFns[typeId];
      if (sampleFn !== null) {
        sampleFn(idx, state, this._highZs, layout);
      }
    }

    for (let g = 0; g < evaluationOrder.length; g++) {
      const group = evaluationOrder[g]!;
      if (group.isFeedback) {
        this._evaluateFeedbackGroup(group, executeFns, typeIds, layout, state);
      } else {
        this._evaluateGroupOnce(group, executeFns, typeIds, layout, state);
      }
    }

    if (busResolver !== null) {
      const burns = busResolver.checkAllBurns();
      if (burns.length > 0) {
        throw burns[0]!;
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
      executeFns[typeId]!(idx, state, this._highZs, layout);
    }

    const busResolver = this._compiled!.busResolver;
    if (busResolver !== null) {
      const outputNets = this._collectOutputNets(indices, layout);
      for (let n = 0; n < outputNets.length; n++) {
        busResolver.onNetChanged(outputNets[n]!, state, this._highZs);
      }
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

    const snapshotBuf = this._compiled!.sccSnapshotBuffer;
    const detector = this._oscillationDetector;
    detector.reset();

    for (let iter = 0; iter < MAX_FEEDBACK_ITERATIONS; iter++) {
      // Snapshot current output values for change detection using pre-allocated buffer
      const snapshot = snapshotBuf.subarray(0, outputNets.length);
      for (let n = 0; n < outputNets.length; n++) {
        snapshot[n] = state[outputNets[n]!]!;
      }

      // Evaluate all components in the group
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]!;
        const typeId = typeIds[idx]!;
        executeFns[typeId]!(idx, state, this._highZs, layout);
      }

      detector.tick();

      // Check if outputs changed; trigger bus resolution for changed nets
      let stable = true;
      const busResolver = this._compiled!.busResolver;
      for (let n = 0; n < outputNets.length; n++) {
        if (state[outputNets[n]!] !== snapshot[n]) {
          stable = false;
          if (busResolver !== null) {
            busResolver.onNetChanged(outputNets[n]!, state, this._highZs);
          }
        }
      }

      if (stable) return;
    }

    // Oscillation limit exceeded — collect oscillating components
    for (let c = 0; c < COLLECTION_STEPS; c++) {
      const snapshot = snapshotBuf.subarray(0, outputNets.length);
      for (let n = 0; n < outputNets.length; n++) {
        snapshot[n] = state[outputNets[n]!]!;
      }

      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]!;
        const typeId = typeIds[idx]!;
        executeFns[typeId]!(idx, state, this._highZs, layout);
      }

      const changed: number[] = [];
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]!;
        const outCount = layout.outputCount(idx);
        const outOffset = layout.outputOffset(idx);
        const wt = layout.wiringTable;
        for (let o = 0; o < outCount; o++) {
          const netId = wt[outOffset + o]!;
          const snIdx = outputNets.indexOf(netId);
          if (snIdx >= 0 && state[netId] !== snapshot[snIdx]) {
            changed.push(idx);
            break;
          }
        }
      }
      detector.collectOscillatingComponents(changed);
    }

    const oscillating = detector.getOscillatingComponents();
    throw new OscillationError(
      `Circuit oscillation detected: ${oscillating.length} component(s) failed to stabilize`,
      {
        iterations: MAX_FEEDBACK_ITERATIONS,
        componentIndices: oscillating,
      },
    );
  }

  private _collectOutputNets(indices: Uint32Array, layout: ComponentLayout): number[] {
    const wt = layout.wiringTable;
    const nets: number[] = [];
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]!;
      const outCount = layout.outputCount(idx);
      const outOffset = layout.outputOffset(idx);
      for (let o = 0; o < outCount; o++) {
        nets.push(wt[outOffset + o]!);
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
    const wt = layout.wiringTable;

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
          const netId = wt[outOffset + o]!;
          beforeValues[o] = state[netId]!;
          beforeHighZs[o] = this._highZs[netId]!;
        }

        executeFns[typeId]!(idx, state, this._highZs, layout);

        // Schedule events for changed outputs
        const delay = BigInt(delays[idx] ?? 10);
        const eventTime = targetTime + delay;

        for (let o = 0; o < outCount; o++) {
          const netId = wt[outOffset + o]!;
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

        executeFns[typeId]!(idx, state, this._highZs, layout);

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
