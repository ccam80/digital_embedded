/**
 * DefaultSimulatorFacade — concrete implementation of SimulatorFacade.
 *
 * Composes CircuitBuilder and SimulationLoader. This is the
 * single entry point for all programmatic circuit building, simulation, and I/O.
 *
 * Engine lifecycle (F2): compile() always creates a fresh engine. The previous
 * engine is stopped and disposed before creating a new one.
 *
 * Clock management (F3): step(), run(), and runToStable() advance clocks before
 * each engine step when clockAdvance is enabled (the default). Clock advancement
 * is handled by the coordinator's advanceClocks() method.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { SimulationEngine } from '../core/engine-interface.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
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
import type { CompiledCircuitUnified } from '../compile/types.js';
import { compileUnified } from '../compile/compile.js';
import { getTransistorModels } from '../solver/analog/default-models.js';
import { SimulationLoader } from './loader.js';
import { serializeCircuit } from '../io/save.js';
import { deserializeCircuit } from '../io/load.js';
import { extractEmbeddedTestData } from './test-runner.js';
import { parseTestData } from '../testing/parser.js';
import { executeTests } from '../testing/executor.js';
import { DefaultSimulationCoordinator } from '../solver/coordinator.js';

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
  private readonly _loader: SimulationLoader;
  private readonly _registry: ComponentRegistry;

  // Active session state (reset on each compile())
  private _circuit: Circuit | null = null;
  private _coordinator: DefaultSimulationCoordinator | null = null;

  constructor(registry: ComponentRegistry) {
    this._registry = registry;
    this._builder = new CircuitBuilder(registry);
    this._loader = new SimulationLoader(registry);
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

  connect(circuit: Circuit, src: CircuitElement, srcPin: string, dst: CircuitElement, dstPin: string): import('../core/circuit.js').Wire {
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

  compile(circuit: Circuit): SimulationCoordinator {
    this._disposeCurrentEngine();

    this._circuit = null;
    this._coordinator = null;

    const unified = compileUnified(circuit, this._registry, getTransistorModels());
    const coordinator = new DefaultSimulationCoordinator(unified, this._registry);
    this._coordinator = coordinator;
    this._circuit = circuit;

    return coordinator;
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
   */
  step(coordinator: SimulationCoordinator | SimulationEngine, opts?: StepOptions): void {
    const advance = opts?.clockAdvance !== false;
    if (advance && 'advanceClocks' in coordinator) {
      (coordinator as SimulationCoordinator).advanceClocks();
    }
    coordinator.step();
  }

  run(coordinator: SimulationCoordinator | SimulationEngine, cycles: number, opts?: StepOptions): void {
    for (let i = 0; i < cycles; i++) {
      this.step(coordinator, opts);
    }
  }

  runToStable(engineOrCoord: SimulationCoordinator | SimulationEngine, maxIterations = 1000, opts?: StepOptions): void {
    const settleOpts = opts ?? { clockAdvance: false };

    const coord: SimulationCoordinator | null =
      'snapshotSignals' in engineOrCoord
        ? (engineOrCoord as SimulationCoordinator)
        : this._coordinator;

    if (coord !== null) {
      for (let iter = 0; iter < maxIterations; iter++) {
        const before = coord.snapshotSignals();
        this.step(coord, settleOpts);
        const after = coord.snapshotSignals();
        let stable = true;
        for (let n = 0; n < before.length; n++) {
          if (before[n] !== after[n]) { stable = false; break; }
        }
        if (stable) return;
      }
    }

    throw new FacadeError(
      `Circuit did not stabilize within ${maxIterations} iterations.`,
    );
  }

  setInput(_engineOrCoord: SimulationCoordinator | SimulationEngine, label: string, value: number): void {
    if (this._coordinator === null) {
      throw new FacadeError('No circuit compiled. Call compile() before setInput().');
    }
    const addr = this._coordinator.compiled.labelSignalMap.get(label);
    if (addr === undefined) {
      const available = [...this._coordinator.compiled.labelSignalMap.keys()].join(', ');
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || '(none)'}`,
      );
    }
    this._coordinator.writeSignal(addr, { type: 'digital', value });
  }

  readOutput(_engineOrCoord: SimulationCoordinator | SimulationEngine, label: string): number {
    if (this._coordinator === null) {
      throw new FacadeError('No circuit compiled. Call compile() before readOutput().');
    }
    const addr = this._coordinator.compiled.labelSignalMap.get(label);
    if (addr === undefined) {
      const available = [...this._coordinator.compiled.labelSignalMap.keys()].join(', ');
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || '(none)'}`,
      );
    }
    const sv = this._coordinator.readSignal(addr);
    return sv.type === 'digital' ? sv.value : sv.voltage;
  }

  readAllSignals(_engineOrCoord: SimulationCoordinator | SimulationEngine): Record<string, number> {
    if (this._coordinator === null) return {};
    const result: Record<string, number> = {};
    for (const [label, sv] of this._coordinator.readAllSignals()) {
      result[label] = sv.type === 'digital' ? sv.value : sv.voltage;
    }
    return result;
  }

  // =========================================================================
  // Testing
  // =========================================================================

  runTests(engineOrCoord: SimulationCoordinator | SimulationEngine, circuit: Circuit, testData?: string): TestResults {
    const resolvedData = testData ?? extractEmbeddedTestData(circuit);

    if (resolvedData === null || resolvedData.trim().length === 0) {
      throw new FacadeError(
        'No test data available: circuit contains no Testcase components and no external test data was provided.',
      );
    }

    // Infer inputCount from the circuit's In/Clock elements when the test
    // data doesn't contain an explicit "|" separator.  parseTestData will
    // prefer an explicit inputCount over a "|" separator over all-inputs.
    let inputCount: number | undefined;
    if (!resolvedData.includes('|')) {
      const inputLabels = new Set<string>();
      for (const el of circuit.elements) {
        if (el.typeId === 'In' || el.typeId === 'Clock') {
          const label = el.getProperties().getOrDefault<string>('label', '');
          if (label) inputLabels.add(label);
        }
      }
      if (inputLabels.size > 0) {
        // Parse the header line to count how many leading columns are inputs
        const headerLine = resolvedData.split('\n').find(l => l.trim().length > 0 && !l.trim().startsWith('#'));
        if (headerLine) {
          const names = headerLine.trim().split(/\s+/);
          let count = 0;
          for (const name of names) {
            if (inputLabels.has(name)) {
              count++;
            } else {
              break;
            }
          }
          if (count > 0 && count < names.length) {
            inputCount = count;
          }
        }
      }
    }

    const parsed = parseTestData(resolvedData, inputCount);

    // Test execution requires a digital engine.
    let digitalEngine: SimulationEngine | null = null;
    if (engineOrCoord instanceof DefaultSimulationCoordinator) {
      digitalEngine = engineOrCoord.getDigitalEngine();
    } else if ('getSignalRaw' in engineOrCoord) {
      digitalEngine = engineOrCoord as SimulationEngine;
    }

    if (digitalEngine === null) {
      throw new FacadeError('Test execution requires a digital engine. Analog-only circuits cannot run test vectors.');
    }

    return executeTests(this, digitalEngine, circuit, parsed);
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

  /** Returns the coordinator as the union type expected by callers that accept either interface. */
  getEngine(): SimulationCoordinator | SimulationEngine | null {
    return this._coordinator;
  }

  /** Returns the currently active DefaultSimulationCoordinator, or null if none compiled yet. */
  getCoordinator(): DefaultSimulationCoordinator | null {
    return this._coordinator;
  }

  /** Returns the last compiled circuit, or null if none compiled yet. */
  getCircuit(): Circuit | null {
    return this._circuit;
  }

  /** Returns the SimulationLoader instance. */
  getLoader(): SimulationLoader {
    return this._loader;
  }

  /** Returns the unified compiled circuit, or null if none compiled yet. */
  getCompiledUnified(): CompiledCircuitUnified | null {
    return this._coordinator?.compiled ?? null;
  }

  /** Returns the DC operating-point result, or null if no analog backend. */
  getDcOpResult(): import('../core/analog-engine-interface.js').DcOpResult | null {
    const coord = this._coordinator;
    if (coord === null) return null;
    return coord.dcOperatingPoint();
  }

  /**
   * Dispose the current engine and clear all session state.
   * Call before discarding a facade instance or when the circuit changes.
   */
  invalidate(): void {
    this._disposeCurrentEngine();
    this._circuit = null;
    this._coordinator = null;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private _disposeCurrentEngine(): void {
    if (this._coordinator === null) return;
    this._coordinator.dispose();
    this._coordinator = null;
  }
}
