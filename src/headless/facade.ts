/**
 * SimulatorFacade: The headless API contract
 *
 * This is the single programmatic surface for LLMs, AI agents, and the postMessage bridge.
 * All methods are grouped by lifecycle stage: building, compilation, simulation, testing, and I/O.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { Wire } from '../core/circuit.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
import type { PropertyValue } from '../core/properties.js';
import type { ComponentDefinition } from '../core/registry.js';
import type { TestResults, CircuitBuildOptions } from './types.js';
import type {
  Netlist,
  CircuitSpec,
  CircuitPatch,
  PatchOptions,
  PatchResult,
} from './netlist-types.js';
import type { Diagnostic } from '../compile/types.js';

/**
 * The primary interface for programmatic circuit building and simulation
 */
export interface SimulatorFacade {
  // ============================================
  // Building: Construct circuit programmatically
  // ============================================

  /**
   * Create a new empty circuit with optional metadata
   */
  createCircuit(opts?: CircuitBuildOptions): Circuit;

  /**
   * Add a component to a circuit by type name
   * Looks up ComponentDefinition in the registry, instantiates via factory,
   * auto-assigns a grid-snapped position, adds to circuit.
   *
   * @param circuit - The circuit to add to
   * @param typeName - Component type name (e.g. "And", "Or", "In")
   * @param props - Optional properties (bitWidth, label, position, etc.)
   * @returns The newly created CircuitElement
   * @throws FacadeError if type unknown, or properties invalid
   */
  addComponent(
    circuit: Circuit,
    typeName: string,
    props?: Record<string, PropertyValue>
  ): CircuitElement;

  /**
   * Connect two component pins with a wire. Validates pin labels exist.
   *
   * @param circuit - The circuit
   * @param srcComponent - Source component
   * @param srcPinLabel - Source pin label (e.g. "Q", "out", "A")
   * @param dstComponent - Destination component
   * @param dstPinLabel - Destination pin label
   * @returns The created Wire
   * @throws FacadeError if pin labels unknown
   */
  connect(
    circuit: Circuit,
    srcComponent: CircuitElement,
    srcPinLabel: string,
    dstComponent: CircuitElement,
    dstPinLabel: string
  ): Wire;

  // ============================================
  // Compilation: Prepare circuit for simulation
  // ============================================

  /**
   * Compile a circuit into an executable simulation engine
   * Transforms the visual circuit model into an optimized executable form:
   * topological sort, net ID assignment, function table construction.
   *
   * @param circuit - The circuit to compile
   * @returns A SimulationCoordinator wrapping the appropriate backend engines
   * @throws FacadeError if circuit is invalid (combinational loops, unconnected pins, etc.)
   */
  compile(circuit: Circuit): SimulationCoordinator;

  // ============================================
  // Simulation: Run and interact with engine
  // ============================================

  /**
   * Execute one propagation cycle of the engine.
   * For analog/mixed circuits, advances the transient solver by one timestep.
   *
   * @param coordinator - The compiled coordinator
   */
  step(coordinator: SimulationCoordinator): void;

  /**
   * Execute N propagation cycles
   * Useful for settling combinational logic or advancing state machines.
   *
   * @param coordinator - The compiled coordinator
   * @param cycles - Number of cycles to execute
   */
  run(coordinator: SimulationCoordinator, cycles: number): void;

  /**
   * Settle the circuit to a stable state.
   *
   * Pure digital: single step with clockAdvance:false (one topological evaluation).
   * Analog/mixed: stepToTime by settleTime seconds of sim time.
   *
   * @param coordinator - The compiled coordinator
   * @param settleTime - Sim-time duration for analog settle (default 0.01 = 10ms)
   */
  settle(coordinator: SimulationCoordinator, settleTime?: number): Promise<void>;

  /**
   * Step until coordinator.simTime >= targetSimTime, with optional wall-clock budget.
   * Returns the number of steps taken. Returns 0 immediately for discrete-only circuits.
   *
   * @param coordinator - The compiled coordinator
   * @param targetSimTime - Target simulation time in seconds
   * @param budgetMs - Wall-clock budget in milliseconds (default 5000)
   */
  stepToTime(coordinator: SimulationCoordinator, targetSimTime: number, budgetMs?: number): Promise<number>;

  /**
   * Write a signal value by label.
   *
   * @param coordinator - The compiled coordinator
   * @param label - Component label (e.g. "SW0", "Clk")
   * @param value - Numeric value to set
   * @throws FacadeError if label not found
   */
  setSignal(coordinator: SimulationCoordinator, label: string, value: number): void;

  /**
   * Read a signal value by label.
   *
   * @param coordinator - The compiled coordinator
   * @param label - Component label
   * @returns The numeric value
   * @throws FacadeError if label not found
   */
  readSignal(coordinator: SimulationCoordinator, label: string): number;

  /**
   * Snapshot all signal values in the circuit
   * For diagnostics, saving/restoring state, and test assertions.
   *
   * @param coordinator - The compiled coordinator
   * @returns Map of net label (or ID string) to current value
   */
  readAllSignals(coordinator: SimulationCoordinator): Record<string, number>;

  // ============================================
  // Testing: Run automated test vectors
  // ============================================

  /**
   * Execute all test vectors defined in the circuit.
   *
   * If testData is provided, it is used as the test vector source instead of
   * the circuit's embedded Testcase components.
   *
   * @param coordinator - The compiled coordinator
   * @param circuit - The circuit (searched for Testcase components when testData is absent)
   * @param testData - Optional external test vector string in Digital test format
   * @returns TestResults with pass/fail counts and per-vector details
   * @throws FacadeError if no test data is available from either source
   */
  runTests(coordinator: SimulationCoordinator, circuit: Circuit, testData?: string): Promise<TestResults>;

  // ============================================
  // File I/O: Load and save circuits
  // ============================================

  /**
   * Parse a .dig XML string and return a Circuit object.
   * Accepts only raw XML strings (starting with "<").
   * For file-path or URL loading use SimulationLoader directly.
   * @param xml - Raw .dig XML content
   * @returns Parsed Circuit
   * @throws FacadeError if XML is invalid
   */
  loadDigXml(xml: string): Circuit;

  /**
   * Serialize a circuit to JSON
   * The JSON format is stable across versions (stable serialization schema).
   *
   * @param circuit - The circuit
   * @returns JSON string
   */
  serialize(circuit: Circuit): string;

  /**
   * Deserialize a circuit from JSON
   * Restores a previously serialized circuit.
   *
   * @param json - JSON string from serialize()
   * @returns Restored Circuit
   * @throws FacadeError if JSON is invalid
   */
  deserialize(json: string): Circuit;

  // ============================================
  // Introspection: Inspect circuit structure
  // ============================================

  /**
   * Extract a netlist view of the circuit: components, nets, and diagnostics.
   *
   * Runs wire tracing and net resolution (compiler steps 1-5) WITHOUT full
   * compilation. Returns every component with its pins, every net with all
   * connected pins and inferred widths, and pre-compilation diagnostics
   * (width mismatches, unconnected pins, etc.).
   *
   * Each pin shows `connectedTo`: all other pins on the same net. This is
   * the primary introspection tool for LLM agents — no coordinate tracing
   * required.
   *
   * @param circuit - The circuit to inspect
   * @returns Netlist with components, nets, and diagnostics
   */
  netlist(circuit: Circuit): Netlist;

  /**
   * Validate circuit structure, returning all diagnostics.
   *
   * Convenience wrapper: equivalent to `netlist(circuit).diagnostics`.
   * Collects ALL errors instead of throwing on the first one.
   *
   * @param circuit - The circuit to validate
   * @returns Array of diagnostics (empty = valid)
   */
  validate(circuit: Circuit): Diagnostic[];

  /**
   * Query the registry for a component type's definition.
   *
   * Returns pin layout, property definitions, category, and help text
   * for a registered component type. Useful for understanding expected
   * pin interfaces before inspecting a circuit.
   *
   * @param typeName - Component type name (e.g. "And", "FlipflopD")
   * @returns ComponentDefinition, or undefined if not registered
   */
  describeComponent(typeName: string): ComponentDefinition | undefined;

  // ============================================
  // Declarative building: Topology-first design
  // ============================================

  /**
   * Build a circuit from a declarative spec.
   *
   * No coordinates, no object references — pure topology. The builder
   * auto-lays-out components and auto-routes wires. Components are
   * addressed by their `spec.id`, pins by `"id:pinLabel"`.
   *
   * @param spec - Declarative circuit description
   * @returns Assembled Circuit ready for compile() or netlist()
   * @throws FacadeError if types are unknown, pin labels invalid, or widths mismatch
   */
  build(spec: CircuitSpec): Circuit;

  // ============================================
  // Patching: Edit existing circuits
  // ============================================

  /**
   * Apply patch operations to an existing circuit.
   *
   * Targets use the same `label` / `label:pin` addressing as netlist output.
   * Operations are applied in order. Returns diagnostics for the patched
   * circuit (empty = valid).
   *
   * For subcircuit edits, set `opts.scope` to the hierarchy path
   * (e.g. "MCU/sysreg") to scope target resolution.
   *
   * @param circuit - The circuit to modify (mutated in place)
   * @param ops - Patch operations to apply
   * @param opts - Optional scope for subcircuit targeting
   * @returns Post-patch diagnostics
   * @throws FacadeError if targets cannot be resolved
   */
  patch(circuit: Circuit, ops: CircuitPatch, opts?: PatchOptions): PatchResult;
}
