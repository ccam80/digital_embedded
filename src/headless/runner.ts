/**
 * SimulationRunner — headless compile-and-run API.
 *
 * Implements the simulation portion of the SimulatorFacade:
 *   compile → step/run/runToStable → setInput/readOutput/readAllSignals
 *
 * Label-based signal access delegates to DefaultSimulationCoordinator, which
 * resolves component labels via the compiled circuit's labelSignalMap.
 */

import type { Circuit } from "@/core/circuit";
import type { Engine, SimulationEngine, CompiledCircuit } from "@/core/engine-interface";
import type { SimulationCoordinator } from "@/compile/coordinator-types.js";
import type { DcOpResult } from "@/core/analog-engine-interface";
import type { ComponentRegistry } from "@/core/registry";
import { OscillationError } from "@/core/errors";
import { compileUnified } from "@/compile/compile.js";
import { getTransistorModels } from "@/analog/default-models.js";
import { DefaultSimulationCoordinator } from "@/compile/coordinator.js";
import { FacadeError } from "./types.js";

/**
 * Factory function that creates and initialises a SimulationEngine from a
 * compiled circuit. The default factory creates a DigitalEngine in level mode.
 */
export type EngineFactory = (compiled: CompiledCircuit) => SimulationEngine;

// ---------------------------------------------------------------------------
// RunnerRecord — coordinator paired with engine key for label resolution
// ---------------------------------------------------------------------------

interface RunnerRecord {
  readonly coordinator: DefaultSimulationCoordinator;
}

// ---------------------------------------------------------------------------
// SimulationRunner
// ---------------------------------------------------------------------------

/**
 * Headless simulation runner.
 *
 * Provides compile/step/run/runToStable and label-based signal access for
 * programmatic circuit simulation in Node.js and test environments.
 */
export class SimulationRunner {
  private readonly _registry: ComponentRegistry;

  /**
   * Maps engine or coordinator instances to their coordinator records for
   * label resolution. WeakMap avoids memory leaks when engines are discarded.
   * Uses `object` key type since values may be Engine, SimulationCoordinator, etc.
   */
  private readonly _records = new WeakMap<object, RunnerRecord>();

  constructor(registry: ComponentRegistry) {
    this._registry = registry;
  }

  // -------------------------------------------------------------------------
  // Compilation
  // -------------------------------------------------------------------------

  /**
   * Compile a circuit into an initialized SimulationEngine.
   *
   * Runs the compiler (topological sort + net assignment), creates a
   * DefaultSimulationCoordinator, and returns the underlying digital or analog
   * backend engine for backward-compatible stepping.
   *
   * @param circuit        The visual circuit model to compile.
   * @param engineFactory  Optional factory to create a non-default engine (digital path only).
   * @returns              A SimulationEngine ready for stepping.
   */
  compile(circuit: Circuit, engineFactory?: EngineFactory): SimulationCoordinator {
    const unified = compileUnified(circuit, this._registry, getTransistorModels());
    const coordinator = new DefaultSimulationCoordinator(unified);

    if (unified.analog !== null) {
      this._records.set(unified.analog, { coordinator });
    }
    if (unified.digital !== null) {
      if (engineFactory !== undefined) {
        const overrideEngine = engineFactory(unified.digital);
        this._records.set(overrideEngine, { coordinator });
      } else {
        this._records.set(coordinator.digitalBackend!, { coordinator });
      }
    }
    this._records.set(coordinator, { coordinator });

    return coordinator;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute one propagation cycle.
   */
  step(engine: SimulationEngine): void {
    const record = this._records.get(engine);
    if (record !== undefined) {
      record.coordinator.step();
    } else {
      engine.step();
    }
  }

  /**
   * Execute N propagation cycles.
   */
  run(engine: SimulationEngine, cycles: number): void {
    const record = this._records.get(engine);
    for (let i = 0; i < cycles; i++) {
      if (record !== undefined) {
        record.coordinator.step();
      } else {
        engine.step();
      }
    }
  }

  /**
   * Execute cycles until no signal changes between steps, or throw OscillationError.
   *
   * Stability is detected by snapshotting all raw signal values before and after
   * each step. If the snapshot is unchanged, the circuit has stabilized.
   *
   * @param engine          The engine to run.
   * @param maxIterations   Maximum steps before declaring oscillation. Default: 1000.
   * @throws OscillationError if the circuit has not stabilized within maxIterations.
   */
  runToStable(engine: SimulationEngine, maxIterations = 1000): void {
    const record = this._records.get(engine);
    const netCount = record?.coordinator.compiled.digital?.netCount
      ?? record?.coordinator.compiled.analog?.netCount
      ?? 64;

    for (let iter = 0; iter < maxIterations; iter++) {
      const before = this._snapshotSignals(engine, netCount);
      if (record !== undefined) {
        record.coordinator.step();
      } else {
        engine.step();
      }
      const after = this._snapshotSignals(engine, netCount);

      let stable = true;
      for (let n = 0; n < netCount; n++) {
        if (before[n] !== after[n]) {
          stable = false;
          break;
        }
      }

      if (stable) return;
    }

    throw new OscillationError(
      `Circuit did not stabilize within ${maxIterations} iterations.`,
      { iterations: maxIterations },
    );
  }

  // -------------------------------------------------------------------------
  // Label-based signal access
  // -------------------------------------------------------------------------

  /**
   * Drive an input net to the given numeric value.
   *
   * Resolves the label via the coordinator's labelSignalMap and writes the
   * appropriate signal value to the correct backend.
   *
   * @throws FacadeError if label is not found in the compiled circuit.
   */
  setInput(engine: SimulationEngine, label: string, value: number): void {
    const record = this._records.get(engine);
    if (record === undefined) {
      throw new FacadeError(
        `Engine was not compiled by this runner or has been disposed. Label: "${label}"`,
      );
    }

    const addr = record.coordinator.compiled.labelSignalMap.get(label);
    if (addr === undefined) {
      const available = [...record.coordinator.compiled.labelSignalMap.keys()].join(", ");
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || "(none)"}`,
      );
    }

    record.coordinator.writeSignal(addr, { type: "digital", value });
  }

  /**
   * Read the current raw numeric value of a labeled output net.
   *
   * For analog signals, returns the node voltage as a number.
   *
   * @throws FacadeError if label is not found in the compiled circuit.
   */
  readOutput(engine: SimulationEngine, label: string): number {
    const record = this._records.get(engine);
    if (record === undefined) {
      throw new FacadeError(
        `Engine was not compiled by this runner or has been disposed. Label: "${label}"`,
      );
    }

    const addr = record.coordinator.compiled.labelSignalMap.get(label);
    if (addr === undefined) {
      const available = [...record.coordinator.compiled.labelSignalMap.keys()].join(", ");
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || "(none)"}`,
      );
    }

    const signalValue = record.coordinator.readSignal(addr);
    return signalValue.type === "digital" ? signalValue.value : signalValue.voltage;
  }

  /**
   * Snapshot all labeled signals in the circuit.
   *
   * Returns a Map of label → numeric value (raw digital or analog voltage).
   */
  readAllSignals(engine: SimulationEngine): Map<string, number> {
    const record = this._records.get(engine);
    const result = new Map<string, number>();

    if (record === undefined) return result;

    for (const [label, addr] of record.coordinator.compiled.labelSignalMap) {
      const signalValue = record.coordinator.readSignal(addr);
      result.set(label, signalValue.type === "digital" ? signalValue.value : signalValue.voltage);
    }

    return result;
  }

  /**
   * Run a DC operating-point analysis on an analog engine.
   *
   * @throws TypeError if the engine is a digital engine.
   */
  dcOperatingPoint(engine: Engine): DcOpResult {
    const record = this._records.get(engine);
    if (record === undefined || record.coordinator.analogBackend === null) {
      throw new TypeError(
        "dcOperatingPoint() requires an analog engine. The provided engine is digital.",
      );
    }
    return record.coordinator.analogBackend.dcOperatingPoint();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the underlying SimulationEngine from a coordinator or engine.
   * When compile() returns a SimulationCoordinator, callers pass it back
   * to step/run/runToStable. This extracts the backend engine for methods
   * that need getSignalRaw() or other SimulationEngine-specific APIs.
   */
  private _resolveBackendEngine(engineOrCoord: SimulationEngine): SimulationEngine {
    const record = this._records.get(engineOrCoord);
    if (record !== undefined) {
      const digital = record.coordinator.digitalBackend;
      if (digital !== null) return digital;
    }
    return engineOrCoord;
  }

  private _snapshotSignals(engine: SimulationEngine, netCount: number): Uint32Array {
    const resolved = this._resolveBackendEngine(engine);
    const snap = new Uint32Array(netCount);
    for (let i = 0; i < netCount; i++) {
      snap[i] = resolved.getSignalRaw(i);
    }
    return snap;
  }
}
