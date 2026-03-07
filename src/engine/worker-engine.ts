/**
 * WorkerEngine -- SimulationEngine proxy that delegates to a Web Worker.
 *
 * Signal state is held in a SharedArrayBuffer-backed Int32Array so the main
 * thread can read values with Atomics.load() without blocking or transferring
 * ownership. All lifecycle commands are sent as EngineMessage via postMessage.
 * The Worker posts EngineResponse messages back for state change notifications.
 *
 * Two parallel arrays are used for each signal:
 *   sharedValues[netId]  -- the value word
 *   sharedHighZs[netId]  -- the high-Z mask word
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
import { BitVector, rawToBitVector, bitVectorToRaw } from "@/core/signal";
import type { EvaluationMode } from "./evaluation-mode.js";

// ---------------------------------------------------------------------------
// ConcreteCompiledCircuit type guard
// ---------------------------------------------------------------------------

interface ConcreteCompiledCircuit extends CompiledCircuit {
  readonly totalStateSlots: number;
  readonly signalArraySize: number;
  readonly typeIds: Uint8Array;
  readonly executeFns: Array<unknown>;
  readonly sampleFns: Array<unknown>;
  readonly wiringTable: Int32Array;
  readonly layout: {
    inputOffset(i: number): number;
    outputOffset(i: number): number;
    inputCount(i: number): number;
    outputCount(i: number): number;
    stateOffset(i: number): number;
    readonly wiringTable: Int32Array;
  };
  readonly evaluationOrder: Array<{
    componentIndices: Uint32Array;
    isFeedback: boolean;
  }>;
  readonly sequentialComponents: Uint32Array;
  readonly netWidths: Uint8Array;
  readonly delays: Uint32Array;
  readonly resetComponentIndices: Uint32Array;
  readonly switchComponentIndices: Uint32Array;
  readonly switchClassification: Uint8Array;
}

function isConcreteCompiled(c: CompiledCircuit): c is ConcreteCompiledCircuit {
  return "typeIds" in c && "wiringTable" in c && "evaluationOrder" in c;
}

// ---------------------------------------------------------------------------
// Build type name list from compiled circuit
// ---------------------------------------------------------------------------

function buildTypeNames(compiled: ConcreteCompiledCircuit): string[] {
  if ("typeNames" in compiled && Array.isArray((compiled as Record<string, unknown>)["typeNames"])) {
    const names = (compiled as Record<string, string[]>)["typeNames"];
    if (names.length > 0) return names;
  }
  const names: string[] = [];
  const maxTypeId = compiled.typeIds.length > 0 ? Math.max(...Array.from(compiled.typeIds)) : -1;
  for (let t = 0; t <= maxTypeId; t++) {
    names.push(`type_${t}`);
  }
  return names;
}

// ---------------------------------------------------------------------------
// WorkerEngine
// ---------------------------------------------------------------------------

/**
 * Main-thread proxy for a DigitalEngine running in a Web Worker.
 *
 * getSignalRaw() uses Atomics.load() -- non-blocking, safe to call from the
 * render loop. All other operations post messages to the Worker.
 */
export class WorkerEngine implements SimulationEngine {
  private readonly _netCount: number;

  // Shared signal storage -- readable from the main thread via Atomics.load()
  private readonly _sharedBuffer: SharedArrayBuffer;
  private readonly _sharedValues: Int32Array;
  private readonly _sharedHighZs: Int32Array;

  // Web Worker (null until a Worker environment is available)
  private _worker: Worker | null = null;

  // Engine state tracked locally (updated from Worker responses)
  private _state: EngineState = EngineState.STOPPED;

  // Net widths for BitVector construction
  private _netWidths: Uint8Array | null = null;

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
    if (!isConcreteCompiled(circuit)) {
      this._postMessage({ type: "reset" });
      return;
    }

    this._netWidths = circuit.netWidths;

    const inputOffsets = new Int32Array(circuit.componentCount);
    const outputOffsets = new Int32Array(circuit.componentCount);
    const inputCounts = new Uint8Array(circuit.componentCount);
    const outputCounts = new Uint8Array(circuit.componentCount);
    const stateOffsets = new Int32Array(circuit.componentCount);

    for (let i = 0; i < circuit.componentCount; i++) {
      inputOffsets[i] = circuit.layout.inputOffset(i);
      outputOffsets[i] = circuit.layout.outputOffset(i);
      inputCounts[i] = circuit.layout.inputCount(i);
      outputCounts[i] = circuit.layout.outputCount(i);
      stateOffsets[i] = circuit.layout.stateOffset(i);
    }

    const typeNames = buildTypeNames(circuit);

    const evaluationGroups = circuit.evaluationOrder.map((g) => ({
      componentIndices: g.componentIndices,
      isFeedback: g.isFeedback,
    }));

    const initMsg: EngineMessage = {
      type: "init",
      sharedBuffer: this._sharedBuffer,
      netCount: circuit.netCount,
      componentCount: circuit.componentCount,
      signalArraySize: circuit.signalArraySize,
      typeIds: circuit.typeIds,
      typeNames,
      inputOffsets,
      outputOffsets,
      inputCounts,
      outputCounts,
      stateOffsets,
      wiringTable: circuit.wiringTable,
      evaluationGroups,
      sequentialComponents: circuit.sequentialComponents,
      netWidths: circuit.netWidths,
      delays: circuit.delays,
      resetComponentIndices: circuit.resetComponentIndices,
      switchComponentIndices: circuit.switchComponentIndices,
      switchClassification: circuit.switchClassification,
    };

    this._worker?.postMessage(initMsg, [this._sharedBuffer]);
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
    const width = this._netWidths !== null ? this._netWidths[netId] ?? 1 : 1;
    const values = new Uint32Array([valueRaw]);
    const highZs = new Uint32Array([highZRaw]);
    return rawToBitVector(values, highZs, 0, width);
  }

  setSignalValue(netId: number, value: BitVector): void {
    if (netId >= this._netCount) return;
    const values = new Uint32Array(1);
    const highZs = new Uint32Array(1);
    bitVectorToRaw(value, values, highZs, 0);
    Atomics.store(this._sharedValues, netId, values[0]!);
    Atomics.store(this._sharedHighZs, netId, highZs[0]!);
    const width = this._netWidths !== null ? this._netWidths[netId] ?? 1 : 1;
    this._postMessage({
      type: "setSignal",
      netId,
      valueLo: values[0]!,
      valueHi: 0,
      highZLo: highZs[0]!,
      highZHi: 0,
      width,
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
  // Snapshot API -- not supported in WorkerEngine (Worker owns state)
  // -------------------------------------------------------------------------

  saveSnapshot(): number {
    this._postMessage({ type: "step" });
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
