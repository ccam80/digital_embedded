/**
 * DefaultSimulatorFacade — concrete implementation of SimulatorFacade.
 *
 * Composes CircuitBuilder and SimulationLoader. This is the
 * single entry point for all programmatic circuit building, simulation, and I/O.
 *
 * Engine lifecycle (F2): compile() always creates a fresh engine. The previous
 * engine is stopped and disposed before creating a new one.
 *
 * Clock management (F3): step() and run() advance clocks before each engine step
 * when clockAdvance is enabled (the default). Clock advancement is handled by
 * the coordinator's advanceClocks() method.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
import type { PropertyValue } from '../core/properties.js';
import type { ComponentDefinition, ComponentRegistry } from '../core/registry.js';
import { createLiveDefinition } from '../components/subcircuit/subcircuit.js';
import type { SubcircuitDefinition } from '../components/subcircuit/subcircuit.js';
import type { ShapeMode } from '../components/subcircuit/shape-renderer.js';
import type { TestResults, CircuitBuildOptions } from './types.js';
import { FacadeError } from './types.js';
import type {
  Netlist,
  CircuitSpec,
  CircuitPatch,
  PatchOptions,
  PatchResult,
} from './netlist-types.js';
import type { Diagnostic } from '../compile/types.js';
import type { SimulatorFacade } from './facade.js';
import { CircuitBuilder } from './builder.js';
import type { CompiledCircuitUnified } from '../compile/types.js';
import { compileUnified } from '../compile/compile.js';
import type { StepRecord } from '../solver/analog/convergence-log.js';

import { SimulationLoader } from './loader.js';
import { serializeCircuit } from '../io/dts-serializer.js';
import { deserializeDts } from '../io/dts-deserializer.js';
import { extractEmbeddedTestData } from './test-runner.js';
import { parseTestData } from '../testing/parser.js';
import { executeTests } from '../testing/executor.js';
import { DefaultSimulationCoordinator } from '../solver/coordinator.js';
import { NullSimulationCoordinator } from '../solver/null-coordinator.js';
import type { MNAEngine } from '../solver/analog/analog-engine.js';

// ---------------------------------------------------------------------------
// Step options — facade-specific, not on the SimulatorFacade interface
// ---------------------------------------------------------------------------

/** Phase-aware capture hook — installed on MNAEngine before compile() fires DCOP. */
type CaptureHook = MNAEngine["stepPhaseHook"];

interface StepOptions {
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
  private _coordinator: SimulationCoordinator = new NullSimulationCoordinator();
  /** Optional capture hook installed on MNAEngine before compile() fires DCOP. */
  private _captureHook: CaptureHook = null;

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

  /**
   * Install a phase-aware capture hook that will be active during the
   * in-compile DCOP solve. Must be called BEFORE compile().
   *
   * This satisfies spec §4.3 / D1: hook-before-compile, not defer-DCOP.
   * The hook fires during the DCOP inside compile(), so the boot step
   * is captured without a second DCOP re-run.
   */
  setCaptureHook(hook: CaptureHook): void {
    this._captureHook = hook;
  }

  compile(circuit: Circuit): SimulationCoordinator {
    this._disposeCurrentEngine();

    this._circuit = null;
    this._coordinator = new NullSimulationCoordinator();

    const unified = compileUnified(circuit, this._registry);
    const coordinator = new DefaultSimulationCoordinator(unified, this._registry, this._captureHook ?? undefined);
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
  step(coordinator: SimulationCoordinator, opts?: StepOptions): void {
    const advance = opts?.clockAdvance !== false;
    if (advance) {
      coordinator.advanceClocks();
    }
    coordinator.step();
  }

  run(coordinator: SimulationCoordinator, cycles: number, opts?: StepOptions): void {
    for (let i = 0; i < cycles; i++) {
      this.step(coordinator, opts);
    }
  }

  stepToTime(coordinator: SimulationCoordinator, targetSimTime: number, budgetMs = 5000): Promise<number> {
    return coordinator.stepToTime(targetSimTime, budgetMs);
  }

  /**
   * Headless batch sampler — no event-loop yields between samples.
   * For test/MCP contexts. See SimulationCoordinator.sampleAtTimes for full docs.
   */
  sampleAtTimes<T>(
    coordinator: SimulationCoordinator,
    times: readonly number[],
    capture: () => T,
    wallBudgetMs?: number,
  ): Promise<readonly T[]> {
    return coordinator.sampleAtTimes(times, capture, wallBudgetMs);
  }

  async settle(coordinator: SimulationCoordinator, settleTime = 0.01): Promise<void> {
    if (coordinator.simTime === null) {
      this.step(coordinator, { clockAdvance: false });
      return;
    }
    await this.stepToTime(coordinator, coordinator.simTime + settleTime);
  }

  setSignal(_coordinator: SimulationCoordinator, label: string, value: number): void {
    const addr = this._coordinator.compiled.labelSignalMap.get(label);
    if (addr === undefined) {
      // The label may belong to a multi-pin analog component (e.g. a voltage
      // source with pins pos/neg) that is not in labelSignalMap as a bare
      // entry. If it exists as a circuit element, route to setSourceByLabel
      // which drives it via its behavioral param (e.g. voltage/amplitude).
      const el = this._coordinator.compiled.labelToCircuitElement.get(label);
      if (el !== undefined) {
        this._coordinator.setSourceByLabel(label, '', value);
        return;
      }
      const available = [...this._coordinator.compiled.labelSignalMap.keys()].join(', ');
      throw new FacadeError(
        `Label "${label}" not found in compiled circuit. Available labels: ${available || '(none)'}`,
      );
    }
    if (addr.domain === 'analog') {
      this._coordinator.setSourceByLabel(label, '', value);
      return;
    }
    this._coordinator.writeSignal(addr, { type: 'digital', value });
  }

  readSignal(_coordinator: SimulationCoordinator, label: string): number {
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

  readAllSignals(_coordinator: SimulationCoordinator): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [label, sv] of this._coordinator.readAllSignals()) {
      result[label] = sv.type === 'digital' ? sv.value : sv.voltage;
    }
    return result;
  }

  // =========================================================================
  // Testing
  // =========================================================================

  async runTests(coordinator: SimulationCoordinator, circuit: Circuit, testData?: string): Promise<TestResults> {
    const resolvedData = testData ?? extractEmbeddedTestData(circuit);

    if (resolvedData === null || resolvedData.trim().length === 0) {
      throw new FacadeError(
        'No test data available: circuit contains no Testcase components and no external test data was provided.',
      );
    }

    // Infer inputCount from the circuit's labeled elements whose labelSignalMap
    // entry has domain === 'analog' (analog sources) or typeId In/Clock/Port.
    let inputCount: number | undefined;
    if (!resolvedData.includes('|')) {
      const inputLabels = new Set<string>();
      for (const el of circuit.elements) {
        if (el.typeId === 'In' || el.typeId === 'Clock' || el.typeId === 'Port') {
          const label = el.getProperties().getOrDefault<string>('label', '');
          if (label) inputLabels.add(label);
        }
      }
      // Also include any analog-domain labeled signals from the compiled map
      for (const [label, addr] of coordinator.compiled.labelSignalMap) {
        if (addr.domain === 'analog') {
          inputLabels.add(label);
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

    return executeTests(this, coordinator, circuit, parsed);
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
    return deserializeDts(json, this._registry);
  }

  async importSubcircuit(
    circuit: Circuit,
    name: string,
    content: string,
    resolver?: import('../io/file-resolver.js').FileResolver,
  ): Promise<SubcircuitDefinition> {
    let subCircuit: Circuit;

    if (content.trimStart().startsWith('{')) {
      // .dts JSON format
      subCircuit = deserializeDts(content, this._registry);
    } else if (resolver) {
      // .dig XML format with resolver for nested subcircuit resolution
      const { loadWithSubcircuits } = await import('../io/subcircuit-loader.js');
      subCircuit = await loadWithSubcircuits(content, resolver, this._registry);
    } else {
      // .dig XML format — no resolver, basic loading only
      const { loadDig } = await import('../io/dig-loader.js');
      subCircuit = loadDig(content, this._registry);
    }

    const shapeType = (subCircuit.metadata.shapeType || 'DEFAULT') as ShapeMode;
    const subDef = createLiveDefinition(subCircuit, shapeType, name);

    if (!circuit.metadata.subcircuits) {
      circuit.metadata.subcircuits = new Map();
    }
    circuit.metadata.subcircuits.set(name, subDef);

    return subDef;
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

  /**
   * Returns the active coordinator (never null — returns NullSimulationCoordinator
   * before compile() is called).
   */
  getCoordinator(): SimulationCoordinator {
    return this._coordinator;
  }

  /**
   * Returns the active DefaultSimulationCoordinator if a circuit has been compiled,
   * or null if no circuit is compiled yet. Use this at sites that need the concrete
   * type (e.g. accessing `.compiled.digital` / `.compiled.analog`).
   */
  getActiveCoordinator(): DefaultSimulationCoordinator | null {
    return this._coordinator instanceof DefaultSimulationCoordinator
      ? this._coordinator
      : null;
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
    const active = this.getActiveCoordinator();
    return active ? active.compiled : null;
  }

  /** Returns the DC operating-point result, or null if no analog backend. */
  getDcOpResult(): import('../core/analog-engine-interface.js').DcOpResult | null {
    return this._coordinator.dcOperatingPoint();
  }

  /** Enable or disable convergence step recording on the analog engine. */
  setConvergenceLogEnabled(enabled: boolean): void {
    this._coordinator.setConvergenceLogEnabled(enabled);
  }

  /** Return recorded convergence steps, or null if no analog domain. */
  getConvergenceLog(lastN?: number): StepRecord[] | null {
    return this._coordinator.getConvergenceLog(lastN);
  }

  /** Clear the convergence log ring buffer. */
  clearConvergenceLog(): void {
    this._coordinator.clearConvergenceLog();
  }

  /**
   * Dispose the current engine and clear all session state.
   * Call before discarding a facade instance or when the circuit changes.
   */
  invalidate(): void {
    this._disposeCurrentEngine();
    this._circuit = null;
    this._coordinator = new NullSimulationCoordinator();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private _disposeCurrentEngine(): void {
    this._coordinator.dispose();
    this._coordinator = new NullSimulationCoordinator();
  }
}
