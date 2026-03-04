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
import type {
  SimulationEngine,
  CompiledCircuit,
  EngineState,
  EngineChangeListener,
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
  | { method: "removeChangeListener" };

export class MockEngine implements SimulationEngine {
  readonly calls: EngineCall[] = [];

  private _state: EngineState = "STOPPED";
  private _values: Uint32Array = new Uint32Array(0);
  private _highZs: Uint32Array = new Uint32Array(0);
  private _netWidths: Map<number, number> = new Map();
  private _defaultWidth = 8;
  private _circuit: CompiledCircuit | null = null;
  private readonly _listeners: Set<EngineChangeListener> = new Set();

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
    this._state = "STOPPED";
  }

  reset(): void {
    this.calls.push({ method: "reset" });
    this._values.fill(0);
    this._highZs.fill(0);
    this._state = "STOPPED";
    this._notifyListeners();
  }

  dispose(): void {
    this.calls.push({ method: "dispose" });
    this._state = "STOPPED";
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
    this._state = "RUNNING";
    this._notifyListeners();
  }

  stop(): void {
    this.calls.push({ method: "stop" });
    this._state = "PAUSED";
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

  /** Reset call log without affecting signal state or circuit. */
  resetCalls(): void {
    this.calls.length = 0;
  }
}
