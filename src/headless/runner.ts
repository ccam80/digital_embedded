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
import type { SimulationEngine } from "@/core/engine-interface";
import type { ComponentRegistry } from "@/core/registry";
import { BitVector } from "@/core/signal";
import { OscillationError } from "@/core/errors";
import { compileCircuit } from "@/engine/compiler";
import { DigitalEngine } from "@/engine/digital-engine";
import type { ConcreteCompiledCircuit } from "@/engine/digital-engine";
import { FacadeError } from "./types.js";

// ---------------------------------------------------------------------------
// EngineRecord — compiled circuit paired with engine for label resolution
// ---------------------------------------------------------------------------

interface EngineRecord {
  readonly engine: DigitalEngine;
  readonly compiled: ConcreteCompiledCircuit;
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
   * Maps SimulationEngine instances to their compiled circuit records for
   * label resolution. WeakMap avoids memory leaks when engines are discarded.
   */
  private readonly _records = new WeakMap<SimulationEngine, EngineRecord>();

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
   * DigitalEngine in level-by-level mode, and calls init() on it.
   *
   * @param circuit  The visual circuit model to compile.
   * @returns        A SimulationEngine ready for stepping.
   */
  compile(circuit: Circuit): SimulationEngine {
    const compiled = compileCircuit(circuit, this._registry) as ConcreteCompiledCircuit;
    const engine = new DigitalEngine("level");
    engine.init(compiled);
    this._records.set(engine, { engine, compiled });
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
   * Resolves the label to a net ID via the compiled circuit's labelToNetId map,
   * then calls engine.setSignalValue().
   *
   * @throws FacadeError if label is not found in the compiled circuit.
   */
  setInput(engine: SimulationEngine, label: string, value: number): void {
    const netId = this._resolveLabel(engine, label);
    engine.setSignalValue(netId, BitVector.fromNumber(value, 1));
  }

  /**
   * Read the current raw numeric value of a labeled output net.
   *
   * @throws FacadeError if label is not found in the compiled circuit.
   */
  readOutput(engine: SimulationEngine, label: string): number {
    const netId = this._resolveLabel(engine, label);
    return engine.getSignalRaw(netId);
  }

  /**
   * Snapshot all labeled signals in the circuit.
   *
   * Returns a Map of label → current raw value for every entry in
   * labelToNetId.
   */
  readAllSignals(engine: SimulationEngine): Map<string, number> {
    const record = this._records.get(engine);
    const result = new Map<string, number>();

    if (record === undefined) return result;

    for (const [label, netId] of record.compiled.labelToNetId) {
      result.set(label, engine.getSignalRaw(netId));
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _resolveLabel(engine: SimulationEngine, label: string): number {
    const record = this._records.get(engine);
    if (record === undefined) {
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
