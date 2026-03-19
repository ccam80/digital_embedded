/**
 * DefaultSimulatorFacade — concrete implementation of SimulatorFacade.
 *
 * Composes CircuitBuilder, SimulationRunner, and SimulationLoader. This is the
 * single entry point for all programmatic circuit building, simulation, and I/O.
 *
 * Engine lifecycle (F2): compile() always creates a fresh engine. The previous
 * engine is stopped and disposed before creating a new one.
 *
 * Clock management (F3): step(), run(), and runToStable() advance clocks before
 * each engine step when clockAdvance is enabled (the default).
 */

import type { Circuit, Wire } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { SimulationEngine } from '../core/engine-interface.js';
import { BitVector } from '../core/signal.js';
import type { PropertyValue } from '../core/properties.js';
import type { ComponentDefinition, ComponentRegistry } from '../core/registry.js';
import type { TestResults, CircuitBuildOptions } from './types.js';
import { FacadeError } from './types.js';
import type {
  Netlist,
  Diagnostic,
  CircuitSpec,
  CircuitPatch,
  PatchOptions,
  PatchResult,
} from './netlist-types.js';
import type { SimulatorFacade } from './facade.js';
import { CircuitBuilder } from './builder.js';
import { SimulationRunner } from './runner.js';
import { ClockManager } from '../engine/clock.js';
import type { ConcreteCompiledCircuit } from '../engine/digital-engine.js';
import { DigitalEngine } from '../engine/digital-engine.js';
import { compileCircuit } from '../engine/compiler.js';
import { compileAnalogCircuit } from '../analog/compiler.js';
import type { CompiledAnalogCircuit, DcOpResult } from '../core/analog-engine-interface.js';
import type { AnalogEngine } from '../core/analog-engine-interface.js';
import { serializeCircuit } from '../io/save.js';
import { deserializeCircuit } from '../io/load.js';
import { extractEmbeddedTestData } from './test-runner.js';
import { parseTestData } from '../testing/parser.js';
import { executeTests } from '../testing/executor.js';

// ---------------------------------------------------------------------------
// Step options — facade-specific, not on the SimulatorFacade interface
// ---------------------------------------------------------------------------

export interface StepOptions {
  /** When false, clocks are not advanced before the engine step. Default: true. */
  clockAdvance?: boolean;
}

// ---------------------------------------------------------------------------
// DefaultSimulatorFacade
// ---------------------------------------------------------------------------

export class DefaultSimulatorFacade implements SimulatorFacade {
  private readonly _builder: CircuitBuilder;
  private readonly _runner: SimulationRunner;
  private readonly _registry: ComponentRegistry;

  // Active session state (reset on each compile())
  private _engine: DigitalEngine | (AnalogEngine & SimulationEngine) | null = null;
  private _clockManager: ClockManager | null = null;
  private _compiled: ConcreteCompiledCircuit | null = null;
  private _compiledAnalog: CompiledAnalogCircuit | null = null;
  private _dcOpResult: DcOpResult | null = null;

  constructor(registry: ComponentRegistry) {
    this._registry = registry;
    this._builder = new CircuitBuilder(registry);
    this._runner = new SimulationRunner(registry);
  }

  // =========================================================================
  // Building — delegates to _builder
  // =========================================================================

  createCircuit(opts?: CircuitBuildOptions): Circuit {
    return this._builder.createCircuit(opts);
  }

  addComponent(circuit: Circuit, typeName: string, props?: Record<string, PropertyValue>): CircuitElement {
    return this._builder.addComponent(circuit, typeName, props);
  }

  connect(circuit: Circuit, src: CircuitElement, srcPin: string, dst: CircuitElement, dstPin: string): Wire {
    return this._builder.connect(circuit, src, srcPin, dst, dstPin);
  }

  build(spec: CircuitSpec): Circuit {
    return this._builder.build(spec);
  }

  patch(circuit: Circuit, ops: CircuitPatch, opts?: PatchOptions): PatchResult {
    return this._builder.patch(circuit, ops, opts);
  }

  // =========================================================================
  // Compilation (F2: fresh engine per compile)
  // =========================================================================

  compile(circuit: Circuit): SimulationEngine {
    this._disposeCurrentEngine();

    this._compiled = null;
    this._compiledAnalog = null;
    this._clockManager = null;
    this._dcOpResult = null;

    const isAnalog = circuit.metadata.engineType === 'analog';

    if (isAnalog) {
      const compiledAnalog = compileAnalogCircuit(circuit, this._registry);
      this._compiledAnalog = compiledAnalog;

      const analogEngine = compiledAnalog as unknown as AnalogEngine & SimulationEngine;
      this._engine = analogEngine;

      try {
        this._dcOpResult = analogEngine.dcOperatingPoint();
      } catch {
        // Convergence failure — engine is still usable for transient simulation.
      }

      return analogEngine;
    }

    // Digital path: compile directly to get ConcreteCompiledCircuit
    const compiled = compileCircuit(circuit, this._registry) as ConcreteCompiledCircuit;
    this._compiled = compiled;

    const engine = new DigitalEngine('level');
    engine.init(compiled);
    this._engine = engine;

    // Also register in the runner's WeakMap so that runTests() can do label
    // resolution. The runner.compile() call is used only for test execution.
    this._clockManager = new ClockManager(compiled);

    return engine;
  }

  // =========================================================================
  // Simulation (F3: clock-aware step)
  // =========================================================================

  /**
   * Execute one propagation cycle.
   *
   * For digital circuits, clocks are advanced before the step by default.
   * Pass { clockAdvance: false } to skip clock advancement (used by test
   * executors that drive clocks manually).
   *
   * Note: the opts parameter is facade-specific and not on SimulatorFacade.
   */
  step(engine: SimulationEngine, opts?: StepOptions): void {
    const advance = opts?.clockAdvance !== false;

    if (advance && this._clockManager !== null && this._engine instanceof DigitalEngine) {
      this._clockManager.advanceClocks(this._engine.getSignalArray());
    }

    engine.step();
  }

  run(engine: SimulationEngine, cycles: number, opts?: StepOptions): void {
    for (let i = 0; i < cycles; i++) {
      this.step(engine, opts);
    }
  }

  runToStable(engine: SimulationEngine, maxIterations = 1000, opts?: StepOptions): void {
    const netCount = this._compiled?.netCount ?? this._compiledAnalog?.netCount ?? 64;

    for (let iter = 0; iter < maxIterations; iter++) {
      const before = this._snapshotSignals(engine, netCount);

      this.step(engine, opts);

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

    throw new FacadeError(
      `Circuit did not stabilize within ${maxIterations} iterations.`,
    );
  }

  setInput(engine: SimulationEngine, label: string, value: number): void {
    if (this._compiledAnalog !== null) {
      // Analog path: delegate to runner which has the WeakMap record.
      this._runner.setInput(engine, label, value);
      return;
    }
    if (this._compiled === null) {
      throw new FacadeError('No circuit compiled. Call compile() before setInput().');
    }
    const netId = this._compiled.labelToNetId.get(label);
    if (netId === undefined) {
      const available = [...this._compiled.labelToNetId.keys()].join(', ');
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || '(none)'}`,
      );
    }
    const width = this._compiled.netWidths[netId] ?? 1;
    engine.setSignalValue(netId, BitVector.fromNumber(value, width));
  }

  readOutput(engine: SimulationEngine, label: string): number {
    if (this._compiledAnalog !== null) {
      return this._runner.readOutput(engine, label);
    }
    if (this._compiled === null) {
      throw new FacadeError('No circuit compiled. Call compile() before readOutput().');
    }
    const netId = this._compiled.labelToNetId.get(label);
    if (netId === undefined) {
      const available = [...this._compiled.labelToNetId.keys()].join(', ');
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || '(none)'}`,
      );
    }
    return engine.getSignalRaw(netId);
  }

  readAllSignals(engine: SimulationEngine): Record<string, number> {
    if (this._compiledAnalog !== null) {
      const map = this._runner.readAllSignals(engine);
      return Object.fromEntries(map);
    }
    if (this._compiled === null) return {};
    const result: Record<string, number> = {};
    for (const [label, netId] of this._compiled.labelToNetId) {
      result[label] = engine.getSignalRaw(netId);
    }
    return result;
  }

  // =========================================================================
  // Testing
  // =========================================================================

  runTests(_engine: SimulationEngine, circuit: Circuit, testData?: string): TestResults {
    const resolvedData = testData ?? extractEmbeddedTestData(circuit);

    if (resolvedData === null || resolvedData.trim().length === 0) {
      throw new FacadeError(
        'No test data available: circuit contains no Testcase components and no external test data was provided.',
      );
    }

    const parsed = parseTestData(resolvedData);
    // Compile a fresh engine via the runner for test execution.
    // This ensures the runner's WeakMap has the record for label resolution.
    const testEngine = this._runner.compile(circuit);
    return executeTests(this._runner, testEngine, circuit, parsed);
  }

  // =========================================================================
  // File I/O
  // =========================================================================

  loadDigXml(xml: string): Circuit {
    return this._builder.loadDig(xml);
  }

  serialize(circuit: Circuit): string {
    return serializeCircuit(circuit);
  }

  deserialize(json: string): Circuit {
    return deserializeCircuit(json, this._registry);
  }

  // =========================================================================
  // Introspection — delegates to _builder
  // =========================================================================

  netlist(circuit: Circuit): Netlist {
    return this._builder.netlist(circuit);
  }

  validate(circuit: Circuit): Diagnostic[] {
    return this._builder.validate(circuit);
  }

  describeComponent(typeName: string): ComponentDefinition | undefined {
    return this._builder.describeComponent(typeName);
  }

  // =========================================================================
  // Session accessors (not on SimulatorFacade interface)
  // =========================================================================

  /** Returns the currently active engine, or null if none compiled yet. */
  getEngine(): SimulationEngine | null {
    return this._engine as SimulationEngine | null;
  }

  /** Returns the ClockManager for the current digital session, or null. */
  getClockManager(): ClockManager | null {
    return this._clockManager;
  }

  /** Returns the compiled digital circuit, or null for analog/uncompiled. */
  getCompiled(): ConcreteCompiledCircuit | null {
    return this._compiled;
  }

  /** Returns the compiled analog circuit, or null for digital/uncompiled. */
  getCompiledAnalog(): CompiledAnalogCircuit | null {
    return this._compiledAnalog;
  }

  /** Returns the last DC operating-point result, or null. */
  getDcOpResult(): DcOpResult | null {
    return this._dcOpResult;
  }

  /**
   * Dispose the current engine and clear all session state.
   * Call before discarding a facade instance or when the circuit changes.
   */
  invalidate(): void {
    this._disposeCurrentEngine();
    this._compiled = null;
    this._compiledAnalog = null;
    this._clockManager = null;
    this._dcOpResult = null;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private _disposeCurrentEngine(): void {
    if (this._engine === null) return;

    const eng = this._engine as unknown as {
      getState?(): string;
      stop?(): void;
      dispose?(): void;
    };

    if (eng.getState?.() === 'RUNNING' && eng.stop) {
      eng.stop();
    }

    if (eng.dispose) {
      eng.dispose();
    }

    this._engine = null;
  }

  private _snapshotSignals(engine: SimulationEngine, netCount: number): Uint32Array {
    const snap = new Uint32Array(netCount);
    for (let i = 0; i < netCount; i++) {
      snap[i] = engine.getSignalRaw(i);
    }
    return snap;
  }
}
