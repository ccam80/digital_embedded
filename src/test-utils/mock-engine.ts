/**
 * Mock SimulationEngine for unit tests.
 *
 * Backs signal state with a plain Uint32Array. Tests can call setSignalRaw()
 * to inject values and then assert on component behaviour. All method calls
 * are recorded so tests can assert that the engine was called in the expected
 * sequence.
 *
 * Signal width per net defaults to 8 bits. Call setNetWidth(netId, width) to
 * override for specific nets before reading via getSignalValue().
 */

import { BitVector, bitVectorToRaw, rawToBitVector } from "@/core/signal";
import { EngineState } from "@/core/engine-interface";
import type {
  SimulationEngine,
  CompiledCircuit,
  EngineChangeListener,
  MeasurementObserver,
  SnapshotId,
} from "@/core/engine-interface";

export type { BitVector };

export type EngineCall =
  | { method: "init"; circuit: CompiledCircuit }
  | { method: "reset" }
  | { method: "dispose" }
  | { method: "step" }
  | { method: "microStep" }
  | { method: "runToBreak" }
  | { method: "start" }
  | { method: "stop" }
  | { method: "getSignalRaw"; netId: number }
  | { method: "getSignalValue"; netId: number }
  | { method: "setSignalValue"; netId: number; value: BitVector }
  | { method: "addChangeListener" }
  | { method: "removeChangeListener" }
  | { method: "addMeasurementObserver" }
  | { method: "removeMeasurementObserver" }
  | { method: "saveSnapshot"; id: SnapshotId }
  | { method: "restoreSnapshot"; id: SnapshotId }
  | { method: "getSnapshotCount"; count: number }
  | { method: "clearSnapshots" }
  | { method: "setSnapshotBudget"; bytes: number };

export class MockEngine implements SimulationEngine {
  readonly calls: EngineCall[] = [];

  private _state: EngineState = EngineState.STOPPED;
  private _values: Uint32Array = new Uint32Array(0);
  private _highZs: Uint32Array = new Uint32Array(0);
  private _netWidths: Map<number, number> = new Map();
  private _defaultWidth = 8;
  private _circuit: CompiledCircuit | null = null;
  private readonly _listeners: Set<EngineChangeListener> = new Set();
  private readonly _measurementObservers: Set<MeasurementObserver> = new Set();

  // Snapshot storage — simple array, no budget enforcement
  private _mockSnapshots: Map<SnapshotId, { values: Uint32Array; highZs: Uint32Array }> = new Map();
  private _nextMockSnapshotId = 0;

  /** Directly set a raw signal value for test setup. No call recorded. */
  setSignalRaw(netId: number, value: number): void {
    if (netId < this._values.length) {
      this._values[netId] = value >>> 0;
      this._highZs[netId] = 0;
    }
  }

  /** Set the bit width to use when constructing BitVector for a specific net. */
  setNetWidth(netId: number, width: number): void {
    this._netWidths.set(netId, width);
  }

  /** Set the default bit width used for all nets without an explicit width override. */
  setDefaultWidth(width: number): void {
    this._defaultWidth = width;
  }

  /** Expose the raw value signal array for direct inspection in tests. */
  get signals(): Uint32Array {
    return this._values;
  }

  /** Expose the circuit passed to init() for test assertions. */
  get circuit(): CompiledCircuit | null {
    return this._circuit;
  }

  private _widthFor(netId: number): number {
    return this._netWidths.get(netId) ?? this._defaultWidth;
  }

  private _notifyListeners(): void {
    for (const listener of this._listeners) {
      listener(this._state);
    }
  }

  init(circuit: CompiledCircuit): void {
    this.calls.push({ method: "init", circuit });
    this._circuit = circuit;
    this._values = new Uint32Array(circuit.netCount);
    this._highZs = new Uint32Array(circuit.netCount);
    this._netWidths.clear();
    this._state = EngineState.STOPPED;
  }

  reset(): void {
    this.calls.push({ method: "reset" });
    this._values.fill(0);
    this._highZs.fill(0);
    this._state = EngineState.STOPPED;
    this._notifyListeners();
  }

  dispose(): void {
    this.calls.push({ method: "dispose" });
    this._state = EngineState.STOPPED;
    this._circuit = null;
    this._listeners.clear();
  }

  step(): void {
    this.calls.push({ method: "step" });
  }

  microStep(): void {
    this.calls.push({ method: "microStep" });
  }

  runToBreak(): void {
    this.calls.push({ method: "runToBreak" });
  }

  start(): void {
    this.calls.push({ method: "start" });
    this._state = EngineState.RUNNING;
    this._notifyListeners();
  }

  stop(): void {
    this.calls.push({ method: "stop" });
    this._state = EngineState.PAUSED;
    this._notifyListeners();
  }

  getState(): EngineState {
    return this._state;
  }

  getSignalRaw(netId: number): number {
    this.calls.push({ method: "getSignalRaw", netId });
    return netId < this._values.length ? (this._values[netId] ?? 0) : 0;
  }

  getSignalValue(netId: number): BitVector {
    this.calls.push({ method: "getSignalValue", netId });
    if (netId >= this._values.length) {
      return BitVector.fromNumber(0, this._widthFor(netId));
    }
    return rawToBitVector(this._values, this._highZs, netId, this._widthFor(netId));
  }

  setSignalValue(netId: number, value: BitVector): void {
    this.calls.push({ method: "setSignalValue", netId, value });
    if (netId < this._values.length) {
      bitVectorToRaw(value, this._values, this._highZs, netId);
    }
  }

  addChangeListener(listener: EngineChangeListener): void {
    this.calls.push({ method: "addChangeListener" });
    this._listeners.add(listener);
  }

  removeChangeListener(listener: EngineChangeListener): void {
    this.calls.push({ method: "removeChangeListener" });
    this._listeners.delete(listener);
  }

  addMeasurementObserver(observer: MeasurementObserver): void {
    this.calls.push({ method: "addMeasurementObserver" });
    this._measurementObservers.add(observer);
  }

  removeMeasurementObserver(observer: MeasurementObserver): void {
    this.calls.push({ method: "removeMeasurementObserver" });
    this._measurementObservers.delete(observer);
  }

  saveSnapshot(): SnapshotId {
    const id = this._nextMockSnapshotId++;
    this._mockSnapshots.set(id, {
      values: this._values.slice(),
      highZs: this._highZs.slice(),
    });
    this.calls.push({ method: "saveSnapshot", id });
    return id;
  }

  restoreSnapshot(id: SnapshotId): void {
    this.calls.push({ method: "restoreSnapshot", id });
    const snapshot = this._mockSnapshots.get(id);
    if (snapshot === undefined) {
      throw new Error(`Snapshot ${id} not found`);
    }
    this._values.set(snapshot.values);
    this._highZs.set(snapshot.highZs);
    this._state = EngineState.PAUSED;
    this._notifyListeners();
  }

  getSnapshotCount(): number {
    const count = this._mockSnapshots.size;
    this.calls.push({ method: "getSnapshotCount", count });
    return count;
  }

  clearSnapshots(): void {
    this.calls.push({ method: "clearSnapshots" });
    this._mockSnapshots.clear();
  }

  setSnapshotBudget(bytes: number): void {
    this.calls.push({ method: "setSnapshotBudget", bytes });
    // No budget enforcement in mock — all snapshots are retained
  }

  /** Reset call log without affecting signal state or circuit. */
  resetCalls(): void {
    this.calls.length = 0;
  }
}
