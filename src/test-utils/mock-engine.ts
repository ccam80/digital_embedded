/**
 * Mock SimulationEngine for unit tests.
 *
 * Backs signal state with a plain Uint32Array. Tests can call setSignalRaw()
 * to inject values and then assert on component behaviour. All method calls
 * are recorded so tests can assert that the engine was called in the expected
 * sequence.
 */

import type {
  SimulationEngine,
  BitVector,
  CompiledCircuit,
  EngineState,
  EngineChangeListener,
} from "@/core/engine-interface";

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

function makeBitVector(raw: number, width: number): BitVector {
  const bigVal = BigInt(raw >>> 0);
  return {
    width,
    value: bigVal,
    toNumber(): number {
      return raw >>> 0;
    },
    toBigInt(): bigint {
      return bigVal;
    },
    toString(radix = 10): string {
      return (raw >>> 0).toString(radix);
    },
  };
}

export class MockEngine implements SimulationEngine {
  readonly calls: EngineCall[] = [];

  private _state: EngineState = "STOPPED";
  private _signals: Uint32Array = new Uint32Array(0);
  private _signalWidth = 1;
  private _circuit: CompiledCircuit | null = null;
  private readonly _listeners: Set<EngineChangeListener> = new Set();

  /** Directly set a raw signal value for test setup. */
  setSignalRaw(netId: number, value: number): void {
    if (netId < this._signals.length) {
      this._signals[netId] = value;
    }
  }

  /** Expose the raw signal array for direct inspection in tests. */
  get signals(): Uint32Array {
    return this._signals;
  }

  private _notifyListeners(): void {
    for (const listener of this._listeners) {
      listener(this._state);
    }
  }

  init(circuit: CompiledCircuit): void {
    this.calls.push({ method: "init", circuit });
    this._circuit = circuit;
    this._signals = new Uint32Array(circuit.netCount);
    this._state = "STOPPED";
  }

  reset(): void {
    this.calls.push({ method: "reset" });
    this._signals.fill(0);
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
    return netId < this._signals.length ? (this._signals[netId] ?? 0) : 0;
  }

  getSignalValue(netId: number): BitVector {
    this.calls.push({ method: "getSignalValue", netId });
    const raw = netId < this._signals.length ? (this._signals[netId] ?? 0) : 0;
    return makeBitVector(raw, this._signalWidth);
  }

  setSignalValue(netId: number, value: BitVector): void {
    this.calls.push({ method: "setSignalValue", netId, value });
    if (netId < this._signals.length) {
      this._signals[netId] = value.toNumber();
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

  /** Reset call log and signal state, keeping circuit. */
  resetCalls(): void {
    this.calls.length = 0;
  }

  /** Configure the bit width used when creating BitVector from raw values. */
  setSignalWidth(width: number): void {
    this._signalWidth = width;
  }
}
