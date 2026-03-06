/**
 * WorkerEngine — SimulationEngine proxy that delegates to a Web Worker.
 *
 * Signal state is held in a SharedArrayBuffer-backed Uint32Array so the main
 * thread can read values with Atomics.load() without blocking or transferring
 * ownership. All lifecycle commands are sent as EngineMessage via postMessage.
 * The Worker posts EngineResponse messages back for state change notifications.
 *
 * Two parallel arrays are used for each signal:
 *   sharedValues[netId]  — the value word
 *   sharedHighZs[netId]  — the high-Z mask word
 *
 * Both are Int32Array views over a single SharedArrayBuffer (Atomics requires
 * Int32Array or BigInt64Array).
 */

import type {
  SimulationEngine,
  CompiledCircuit,
  EngineChangeListener,
  EngineMessage,
  EngineResponse,
  MeasurementObserver,
} from "@/core/engine-interface";
import { EngineState } from "@/core/engine-interface";
import { BitVector, rawToBitVector } from "@/core/signal";
import type { EvaluationMode } from "./evaluation-mode.js";

// ---------------------------------------------------------------------------
// WorkerEngine
// ---------------------------------------------------------------------------

/**
 * Main-thread proxy for a DigitalEngine running in a Web Worker.
 *
 * getSignalRaw() uses Atomics.load() — non-blocking, safe to call from the
 * render loop. All other operations post messages to the Worker.
 */
export class WorkerEngine implements SimulationEngine {
  private readonly _netCount: number;

  // Shared signal storage — readable from the main thread via Atomics.load()
  private readonly _sharedBuffer: SharedArrayBuffer;
  private readonly _sharedValues: Int32Array;
  private readonly _sharedHighZs: Int32Array;

  // Web Worker (null until a Worker environment is available)
  private _worker: Worker | null = null;

  // Engine state tracked locally (updated from Worker responses)
  private _state: EngineState = EngineState.STOPPED;

  // Registered listeners and observers
  private readonly _changeListeners: Set<EngineChangeListener> = new Set();
  private readonly _measurementObservers: Set<MeasurementObserver> = new Set();

  constructor(netCount: number, mode: EvaluationMode) {
    this._netCount = netCount;
    void mode;

    // Allocate two Int32Array slots per net (value + highZ), packed into
    // one SharedArrayBuffer.
    const byteLength = netCount * 2 * Int32Array.BYTES_PER_ELEMENT;
    this._sharedBuffer = new SharedArrayBuffer(byteLength);
    this._sharedValues = new Int32Array(this._sharedBuffer, 0, netCount);
    this._sharedHighZs = new Int32Array(this._sharedBuffer, netCount * Int32Array.BYTES_PER_ELEMENT, netCount);

    this._spawnWorker();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(circuit: CompiledCircuit): void {
    this._postMessage({ type: "reset" });
    void circuit;
  }

  reset(): void {
    this._postMessage({ type: "reset" });
  }

  dispose(): void {
    this._postMessage({ type: "dispose" });
    if (this._worker !== null) {
      this._worker.terminate();
      this._worker = null;
    }
    this._changeListeners.clear();
    this._measurementObservers.clear();
    this._setState(EngineState.STOPPED);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  step(): void {
    this._postMessage({ type: "step" });
  }

  microStep(): void {
    this._postMessage({ type: "microStep" });
  }

  runToBreak(): void {
    this._postMessage({ type: "runToBreak" });
  }

  start(): void {
    this._setState(EngineState.RUNNING);
    this._postMessage({ type: "start" });
  }

  stop(): void {
    this._postMessage({ type: "stop" });
    this._setState(EngineState.PAUSED);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  getState(): EngineState {
    return this._state;
  }

  // -------------------------------------------------------------------------
  // Signal access
  // -------------------------------------------------------------------------

  /**
   * Non-blocking read of raw signal value from the shared buffer.
   * Safe to call from the render loop on the main thread.
   */
  getSignalRaw(netId: number): number {
    if (netId >= this._netCount) return 0;
    return Atomics.load(this._sharedValues, netId);
  }

  getSignalValue(netId: number): BitVector {
    if (netId >= this._netCount) {
      return BitVector.allUndefined(1);
    }
    const valueRaw = Atomics.load(this._sharedValues, netId);
    const highZRaw = Atomics.load(this._sharedHighZs, netId);
    // Build a temporary Uint32Array pair for rawToBitVector
    const values = new Uint32Array([valueRaw]);
    const highZs = new Uint32Array([highZRaw]);
    return rawToBitVector(values, highZs, 0, 1);
  }

  setSignalValue(netId: number, value: BitVector): void {
    if (netId >= this._netCount) return;
    // Extract raw words from BitVector
    const values = new Uint32Array(1);
    const highZs = new Uint32Array(1);
    import("@/core/signal").then(({ bitVectorToRaw }) => {
      bitVectorToRaw(value, values, highZs, 0);
      // Update shared buffer so main-thread reads reflect the new value
      Atomics.store(this._sharedValues, netId, values[0]!);
      Atomics.store(this._sharedHighZs, netId, highZs[0]!);
    });
    // Post message to Worker to propagate on next step
    const valueLo = Number(value.valueBits & 1n);
    this._postMessage({
      type: "setSignal",
      netId,
      valueLo,
      valueHi: 0,
      highZLo: 0,
      highZHi: 0,
      width: 1,
    });
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
  // Snapshot API — not supported in WorkerEngine (Worker owns state)
  // -------------------------------------------------------------------------

  saveSnapshot(): number {
    this._postMessage({ type: "step" }); // no-op placeholder
    return -1;
  }

  restoreSnapshot(_id: number): void {
    // not supported
  }

  getSnapshotCount(): number {
    return 0;
  }

  clearSnapshots(): void {
    // not supported
  }

  setSnapshotBudget(_bytes: number): void {
    // not supported
  }

  // -------------------------------------------------------------------------
  // Private: Worker lifecycle
  // -------------------------------------------------------------------------

  private _spawnWorker(): void {
    if (typeof Worker === "undefined") return;

    try {
      this._worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      this._worker.onmessage = (ev: MessageEvent<EngineResponse>) => {
        this._handleResponse(ev.data);
      };
      this._worker.onerror = (ev: ErrorEvent) => {
        this._setState(EngineState.ERROR);
        void ev;
      };
    } catch {
      // Worker spawn failed (e.g. CSP restrictions) — engine stays in STOPPED
      this._worker = null;
    }
  }

  private _postMessage(msg: EngineMessage): void {
    this._worker?.postMessage(msg);
  }

  private _handleResponse(response: EngineResponse): void {
    switch (response.type) {
      case "stateChange":
        this._setState(response.state);
        break;
      case "error":
        this._setState(EngineState.ERROR);
        break;
      case "breakpoint":
        this._setState(EngineState.STOPPED);
        break;
    }
  }

  private _setState(state: EngineState): void {
    this._state = state;
    for (const listener of this._changeListeners) {
      listener(state);
    }
  }
}
