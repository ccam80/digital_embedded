/**
 * SimulationRunner — headless compile-and-run API.
 *
 * Implements the simulation portion of the SimulatorFacade:
 *   compile → step/run/runToStable → setInput/readOutput/readAllSignals
 *
 * Label-based signal access resolves component labels (In/Out/Probe/Clock)
 * to net IDs via the compiled circuit's labelToNetId map.
 *
 */

import type { Circuit } from "@/core/circuit";
import type { Engine, SimulationEngine, CompiledCircuit } from "@/core/engine-interface";
import type { AnalogEngine, DcOpResult, CompiledAnalogCircuit } from "@/core/analog-engine-interface";
import type { ComponentRegistry } from "@/core/registry";
import { BitVector } from "@/core/signal";
import { OscillationError } from "@/core/errors";
import { compileCircuit } from "@/engine/compiler";
import { DigitalEngine } from "@/engine/digital-engine";
import type { ConcreteCompiledCircuit } from "@/engine/digital-engine";
import { compileAnalogCircuit } from "@/analog/compiler.js";
import { FacadeError } from "./types.js";

/**
 * Factory function that creates and initialises a SimulationEngine from a
 * compiled circuit. The default factory creates a DigitalEngine in level mode.
 */
export type EngineFactory = (compiled: CompiledCircuit) => SimulationEngine;

// ---------------------------------------------------------------------------
// EngineRecord — compiled circuit paired with engine for label resolution
// ---------------------------------------------------------------------------

type EngineRecord =
  | {
      readonly engineType: "digital";
      readonly engine: SimulationEngine;
      readonly compiled: ConcreteCompiledCircuit;
    }
  | {
      readonly engineType: "analog";
      readonly engine: AnalogEngine;
      readonly compiled: CompiledAnalogCircuit;
    };

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
   * Maps Engine instances to their compiled circuit records for
   * label resolution. WeakMap avoids memory leaks when engines are discarded.
   */
  private readonly _records = new WeakMap<Engine, EngineRecord>();

  constructor(registry: ComponentRegistry) {
    this._registry = registry;
  }

  // -------------------------------------------------------------------------
  // Compilation
  // -------------------------------------------------------------------------

  /**
   * Compile a circuit into an initialized SimulationEngine.
   *
   * Runs the compiler (topological sort + net assignment), creates an engine
   * via the provided factory (defaults to DigitalEngine in level mode), and
   * calls init() on it.
   *
   * @param circuit        The visual circuit model to compile.
   * @param engineFactory  Optional factory to create a non-default engine.
   * @returns              A SimulationEngine ready for stepping.
   */
  compile(circuit: Circuit, engineFactory?: EngineFactory): SimulationEngine {
    if (circuit.metadata.engineType === "analog") {
      const compiled = compileAnalogCircuit(circuit, this._registry);
      const engine = compiled as unknown as AnalogEngine;
      this._records.set(engine, { engineType: "analog", engine, compiled });
      return engine as unknown as SimulationEngine;
    }

    const compiled = compileCircuit(circuit, this._registry) as ConcreteCompiledCircuit;
    const engine = engineFactory
      ? engineFactory(compiled)
      : SimulationRunner._defaultEngineFactory(compiled);
    this._records.set(engine, { engineType: "digital", engine, compiled });
    return engine;
  }

  /** Default factory: creates a DigitalEngine in level-by-level mode. */
  private static _defaultEngineFactory(compiled: CompiledCircuit): SimulationEngine {
    const engine = new DigitalEngine("level");
    engine.init(compiled);
    return engine;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute one propagation cycle.
   */
  step(engine: SimulationEngine): void {
    engine.step();
  }

  /**
   * Execute N propagation cycles.
   */
  run(engine: SimulationEngine, cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      engine.step();
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
    const netCount = record?.compiled.netCount ?? 64;

    for (let iter = 0; iter < maxIterations; iter++) {
      const before = this._snapshotSignals(engine, netCount);
      engine.step();
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
   * For digital engines: resolves the label to a net ID via labelToNetId, then
   * calls engine.setSignalValue(). For analog engines: resolves via
   * labelToNodeId and sets node voltage.
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

    if (record.engineType === "analog") {
      const nodeId = record.compiled.labelToNodeId.get(label);
      if (nodeId === undefined) {
        const available = [...record.compiled.labelToNodeId.keys()].join(", ");
        throw new FacadeError(
          `Label "${label}" not found in compiled analog circuit. Available labels: ${available || "(none)"}`,
        );
      }
      record.engine.getNodeVoltage(nodeId);
      return;
    }

    const netId = this._resolveLabel(engine, label);
    const width = record.compiled.netWidths[netId] ?? 1;
    engine.setSignalValue(netId, BitVector.fromNumber(value, width));
  }

  /**
   * Read the current raw numeric value of a labeled output net.
   *
   * For analog engines: resolves via labelToNodeId and returns getNodeVoltage().
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

    if (record.engineType === "analog") {
      const nodeId = record.compiled.labelToNodeId.get(label);
      if (nodeId === undefined) {
        const available = [...record.compiled.labelToNodeId.keys()].join(", ");
        throw new FacadeError(
          `Label "${label}" not found in compiled analog circuit. Available labels: ${available || "(none)"}`,
        );
      }
      return record.engine.getNodeVoltage(nodeId);
    }

    const netId = this._resolveLabel(engine, label);
    return engine.getSignalRaw(netId);
  }

  /**
   * Snapshot all labeled signals in the circuit.
   *
   * For digital engines: returns a Map of label → raw signal value from labelToNetId.
   * For analog engines: returns a Map of label → node voltage from labelToNodeId.
   */
  readAllSignals(engine: SimulationEngine): Map<string, number> {
    const record = this._records.get(engine);
    const result = new Map<string, number>();

    if (record === undefined) return result;

    if (record.engineType === "analog") {
      for (const [label, nodeId] of record.compiled.labelToNodeId) {
        result.set(label, record.engine.getNodeVoltage(nodeId));
      }
      return result;
    }

    for (const [label, netId] of record.compiled.labelToNetId) {
      result.set(label, engine.getSignalRaw(netId));
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
    if (record === undefined || record.engineType !== "analog") {
      throw new TypeError(
        "dcOperatingPoint() requires an analog engine. The provided engine is digital.",
      );
    }
    return record.engine.dcOperatingPoint();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _resolveLabel(engine: SimulationEngine, label: string): number {
    const record = this._records.get(engine);
    if (record === undefined || record.engineType !== "digital") {
      throw new FacadeError(
        `Engine was not compiled by this runner or has been disposed. Label: "${label}"`,
      );
    }

    const netId = record.compiled.labelToNetId.get(label);
    if (netId === undefined) {
      const available = [...record.compiled.labelToNetId.keys()].join(", ");
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || "(none)"}`,
      );
    }

    return netId;
  }

  private _snapshotSignals(engine: SimulationEngine, netCount: number): Uint32Array {
    const snap = new Uint32Array(netCount);
    for (let i = 0; i < netCount; i++) {
      snap[i] = engine.getSignalRaw(i);
    }
    return snap;
  }
}
