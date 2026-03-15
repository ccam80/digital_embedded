/**
 * Engine interface — pluggable simulation contract.
 *
 * The editor and renderer always call through this interface. The concrete
 * implementation may run on the main thread or in a Web Worker backed by
 * SharedArrayBuffer. No editor or renderer code imports a concrete engine.
 *
 * Web Worker compatibility: this module has no DOM references. Signal state
 * is backed by SharedArrayBuffer-compatible typed arrays. Control is exercised
 * via message-passable EngineMessage commands.
 *
 */

import type { BitVector } from "./signal";

export type { BitVector };

// ---------------------------------------------------------------------------
// CompiledCircuit — opaque input produced by the compiler (Phase 3)
// ---------------------------------------------------------------------------

/**
 * The executable representation of a circuit, produced by the compiler
 * (Phase 3, task 3.2.1) from a visual Circuit model.
 *
 * Defined here as an opaque interface so that Phase 1 types can reference it
 * without depending on the compiler implementation.
 */
export interface CompiledCircuit {
  /** Total number of nets (signal slots) in the circuit. */
  readonly netCount: number;
  /** Total number of component instances in the circuit. */
  readonly componentCount: number;
}

// ---------------------------------------------------------------------------
// EngineState — lifecycle state of the simulation engine
// ---------------------------------------------------------------------------

/** Current execution state of a SimulationEngine. */
export const enum EngineState {
  STOPPED = "STOPPED",
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
  ERROR = "ERROR",
}

// ---------------------------------------------------------------------------
// EngineChangeListener — observation callback
// ---------------------------------------------------------------------------

/**
 * Callback invoked whenever the engine transitions to a new EngineState.
 * Called on the same thread as the engine (main thread or Worker).
 */
export type EngineChangeListener = (state: EngineState) => void;

// ---------------------------------------------------------------------------
// SimulationEvent — event in the event-driven engine's priority queue
// ---------------------------------------------------------------------------

/**
 * A scheduled event in the event-driven simulation engine.
 *
 * Events are ordered by timestamp in a priority queue. When multiple events
 * share the same timestamp, they are processed in insertion order (stable).
 *
 */
export interface SimulationEvent {
  /** Simulation time at which this event fires (nanoseconds). */
  readonly timestamp: bigint;
  /** Net ID whose value changes when this event fires. */
  readonly netId: number;
  /** New value for the net. */
  readonly value: number;
}

// ---------------------------------------------------------------------------
// MeasurementObserver — observation interface for data table / measurement panel
// ---------------------------------------------------------------------------

/**
 * Observer interface for measurement data collection during simulation.
 *
 * Registered observers are notified after each simulation step completes,
 * allowing the data table and measurement panel to capture signal snapshots.
 *
 */
export interface MeasurementObserver {
  /** Called after each simulation step with the current step count. */
  onStep(stepCount: number): void;
  /** Called when the simulation is reset. */
  onReset(): void;
}

// ---------------------------------------------------------------------------
// EngineMessage — Worker-safe command envelope
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all commands that can be sent to an engine running
 * inside a Web Worker. All fields must be structured-clone-compatible
 * (no functions, no class instances, no DOM references).
 */
export type EngineMessage =
  | { type: "step" }
  | { type: "microStep" }
  | { type: "runToBreak" }
  | { type: "start" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "dispose" }
  | {
      type: "setSignal";
      netId: number;
      /** Raw value word (low 32 bits for >32-bit signals). */
      valueLo: number;
      /** High 32 bits; 0 for signals ≤ 32 bits. */
      valueHi: number;
      /** HIGH_Z mask word (low 32 bits). */
      highZLo: number;
      /** HIGH_Z mask high word; 0 for signals ≤ 32 bits. */
      highZHi: number;
      /** Bit width of the signal (1–64). */
      width: number;
    }
  | {
      /**
       * Transfers a compiled circuit's typed arrays and SharedArrayBuffer to
       * the worker. The worker reconstructs a ConcreteCompiledCircuit using
       * its own registry for the function table.
       *
       * The sharedBuffer (SharedArrayBuffer) is shared -- both threads retain
       * access. All typed arrays are structured-cloned (copied).
       */
      type: "init";
      sharedBuffer: SharedArrayBuffer;
      netCount: number;
      componentCount: number;
      signalArraySize: number;
      typeIds: Uint16Array;
      typeNames: string[];
      inputOffsets: Int32Array;
      outputOffsets: Int32Array;
      inputCounts: Uint8Array;
      outputCounts: Uint8Array;
      stateOffsets: Int32Array;
      wiringTable: Int32Array;
      evaluationGroups: Array<{
        componentIndices: Uint32Array;
        isFeedback: boolean;
      }>;
      sequentialComponents: Uint32Array;
      netWidths: Uint8Array;
      delays: Uint32Array;
      resetComponentIndices: Uint32Array;
      switchComponentIndices: Uint32Array;
      switchClassification: Uint8Array;
    };

// ---------------------------------------------------------------------------
// EngineResponse — replies posted back from the Worker to the main thread
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all messages a Worker-mode engine posts back to the
 * main thread. All fields must be structured-clone-compatible.
 */
export type EngineResponse =
  | { type: "stateChange"; state: EngineState }
  | { type: "error"; message: string }
  | { type: "breakpoint" };

// ---------------------------------------------------------------------------
// Snapshot API — time-travel state capture
// ---------------------------------------------------------------------------

/**
 * Opaque identifier for a saved engine snapshot.
 * Returned by saveSnapshot() and passed to restoreSnapshot().
 */
export type SnapshotId = number;

// ---------------------------------------------------------------------------
// SimulationEngine — pluggable simulation contract
// ---------------------------------------------------------------------------

/**
 * The simulation engine interface. All editor, renderer, and tool code
 * interacts with the engine exclusively through this interface.
 *
 * Implementations:
 *  - Main-thread engine: runs synchronously; signal array is a plain Uint32Array.
 *  - Web Worker engine: runs in a Worker; signal array is backed by SharedArrayBuffer;
 *    UI reads signals through Atomics.load() via getSignalRaw().
 *
 * The rendering code is identical in both modes — it always calls getSignalRaw().
 */
export interface SimulationEngine {
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialise the engine with a compiled circuit.
   * Allocates the signal state array sized to circuit.netCount.
   * Must be called before any step/start/signal methods.
   */
  init(circuit: CompiledCircuit): void;

  /**
   * Reset all signal values to their initial state and transition to STOPPED.
   * Does not reinitialise the compiled circuit — the same circuit remains active.
   */
  reset(): void;

  /**
   * Release all resources held by the engine.
   * After dispose(), the engine must not be used again without a new init().
   */
  dispose(): void;

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Advance one full propagation cycle: evaluate all combinational logic
   * until a stable state is reached.
   */
  step(): void;

  /**
   * Advance by a single gate evaluation (event-driven micro-step mode).
   * Used for educational step-through debugging.
   */
  microStep(): void;

  /**
   * Run the simulation until a Break component fires or an error occurs.
   */
  runToBreak(): void;

  // -------------------------------------------------------------------------
  // Continuous run
  // -------------------------------------------------------------------------

  /**
   * Begin continuous simulation. Transitions to RUNNING state.
   * The engine evaluates cycles at its internal tick rate.
   */
  start(): void;

  /**
   * Pause continuous simulation. Transitions to PAUSED state.
   * Signal values are preserved and can be inspected.
   */
  stop(): void;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Return the current execution state of the engine. */
  getState(): EngineState;

  // -------------------------------------------------------------------------
  // Signal access (Decision 2: engine owns the Uint32Array)
  // -------------------------------------------------------------------------

  /**
   * Return the raw bit value for a net. Non-allocating.
   *
   * For signals ≤ 32 bits: returns the value word directly.
   * For signals > 32 bits: returns only the low 32 bits. Use getSignalValue()
   * to obtain the full-width value.
   *
   * In Worker mode: implemented as Atomics.load(sharedView, netId).
   * In main-thread mode: implemented as return state[netId].
   *
   * Use this in the render loop for wire coloring (called thousands of times
   * per frame). Never hold a reference to the underlying array directly.
   */
  getSignalRaw(netId: number): number;

  /**
   * Return a BitVector for a net. Allocates a new BitVector object.
   *
   * Returns the full-width signal value including HIGH_Z state.
   * Use this in property panels, tooltips, and data tables where allocation
   * frequency is low (~few calls per frame).
   */
  getSignalValue(netId: number): BitVector;

  /**
   * Set the value of an input net from the UI (e.g. interactive button press).
   * The engine propagates the new value on the next step or tick.
   */
  setSignalValue(netId: number, value: BitVector): void;

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /**
   * Register a listener to be called on every engine state transition.
   * Safe to call multiple times with different listeners.
   */
  addChangeListener(listener: EngineChangeListener): void;

  /**
   * Remove a previously registered listener. No-op if the listener was not
   * registered.
   */
  removeChangeListener(listener: EngineChangeListener): void;

  // -------------------------------------------------------------------------
  // Measurement
  // -------------------------------------------------------------------------

  /**
   * Register an observer for measurement data collection.
   * Called after each simulation step completes.
   */
  addMeasurementObserver(observer: MeasurementObserver): void;

  /**
   * Remove a previously registered measurement observer.
   */
  removeMeasurementObserver(observer: MeasurementObserver): void;

  // -------------------------------------------------------------------------
  // Snapshot API — state capture and time-travel restore
  // -------------------------------------------------------------------------

  /**
   * Capture the full engine state (signal values, highZ masks, undefined flags,
   * step count) and store it in an internal ring buffer.
   *
   * Returns a SnapshotId that can later be passed to restoreSnapshot().
   * Oldest snapshots are evicted when the memory budget is exceeded.
   */
  saveSnapshot(): SnapshotId;

  /**
   * Restore the engine to the state captured by saveSnapshot(id).
   * Transitions the engine to PAUSED after restoring.
   *
   * Throws if id does not correspond to a currently stored snapshot.
   */
  restoreSnapshot(id: SnapshotId): void;

  /** Return the number of snapshots currently stored in the ring buffer. */
  getSnapshotCount(): number;

  /**
   * Discard all stored snapshots and free associated memory.
   * getSnapshotCount() will return 0 after this call.
   */
  clearSnapshots(): void;

  /**
   * Set the maximum number of bytes the snapshot ring buffer may occupy.
   * Defaults to 512 * 1024 (512 KB). When a new snapshot would exceed the
   * budget, the oldest snapshot is evicted.
   */
  setSnapshotBudget(bytes: number): void;
}
