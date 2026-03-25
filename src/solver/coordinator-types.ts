/**
 * SimulationCoordinator interface — unified simulation contract for all
 * circuit types (digital-only, analog-only, mixed-signal).
 *
 * The coordinator wraps both backend engines and the bridge cross-reference
 * map, providing unified signal routing, label resolution, and observer
 * management across all active solver backends.
 *
 * Spec: unified-component-architecture.md Section 5 (Phase 4).
 */

import type { SimulationEngine, MeasurementObserver, SnapshotId } from "../core/engine-interface.js";
import { EngineState } from "../core/engine-interface.js";
import type { AnalogEngine, DcOpResult } from "../core/analog-engine-interface.js";
import type { Diagnostic, SignalAddress, SignalValue } from "../compile/types.js";
import type { AcParams, AcResult } from "./analog/ac-analysis.js";
import type { Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { AnalogElement } from "./analog/element.js";

/**
 * Result of computeFrameSteps — describes how to advance simulation this frame.
 *
 * For discrete timing: steps > 0, simTimeGoal is null, budgetMs is Infinity.
 * For continuous timing: steps is 0, simTimeGoal is the target simTime, budgetMs limits wall time.
 */
export interface FrameStepResult {
  /** How many coordinator.step() calls to make this frame (discrete only). */
  steps: number;
  /** For continuous: the simTime goal to reach. Null for discrete. */
  simTimeGoal: number | null;
  /** Wall-clock budget in ms (for continuous time-limited stepping). */
  budgetMs: number;
  /** Whether the frame missed its target (continuous only). */
  missed: boolean;
}

/**
 * Unified coordinator interface for all simulation modes.
 *
 * A single `SimulationCoordinator` instance manages one or both of the
 * digital and analog backends, bridge synchronisation between them, and
 * observer notification after each step.
 */
export interface SimulationCoordinator {
  /** Advance one full step across all active solver backends. */
  step(): void;

  /** Start continuous simulation across all backends. */
  start(): void;

  /** Stop all backends. */
  stop(): void;

  /** Reset all backends to initial state. */
  reset(): void;

  /** Dispose all backends and release resources. */
  dispose(): void;

  /** Read a signal by address (polymorphic across domains). */
  readSignal(addr: SignalAddress): SignalValue;

  /** Write an input signal by address. */
  writeSignal(addr: SignalAddress, value: SignalValue): void;

  /** Read a signal by component label. */
  readByLabel(label: string): SignalValue;

  /** Write an input signal by component label. */
  writeByLabel(label: string, value: SignalValue): void;

  /** Read all labeled signals. Returns Map<label, SignalValue>. */
  readAllSignals(): Map<string, SignalValue>;

  /** Access the digital backend. Null if no digital domain. */
  readonly digitalBackend: SimulationEngine | null;

  /** Access the analog backend. Null if no analog domain. */
  readonly analogBackend: AnalogEngine | null;

  /**
   * Unified compilation output. Only the domain-agnostic maps and diagnostics
   * are exposed to consumers via this interface. Access to compiled.digital or
   * compiled.analog is restricted to solver-internal code (src/solver/ and
   * src/compile/) using the concrete class or casts.
   */
  readonly compiled: {
    readonly wireSignalMap: ReadonlyMap<Wire, SignalAddress>;
    readonly labelSignalMap: ReadonlyMap<string, SignalAddress>;
    readonly diagnostics: readonly Diagnostic[];
  };

  /** Register a measurement observer (notified after each step). */
  addMeasurementObserver(observer: MeasurementObserver): void;

  /** Remove a measurement observer. */
  removeMeasurementObserver(observer: MeasurementObserver): void;

  // -------------------------------------------------------------------------
  // §1.1 Capability queries (replace analogBackend/digitalBackend null-checks)
  // -------------------------------------------------------------------------

  /** True when the coordinator can perform a micro-step (gate-level single evaluation). */
  supportsMicroStep(): boolean;

  /** True when the coordinator can run-to-breakpoint. */
  supportsRunToBreak(): boolean;

  /** True when AC frequency sweep analysis is available. */
  supportsAcSweep(): boolean;

  /** True when a DC operating point can be computed. */
  supportsDcOp(): boolean;

  // -------------------------------------------------------------------------
  // §1.2 Unified feature execution (replace backend reach-through)
  // -------------------------------------------------------------------------

  /** Execute a single micro-step (digital gate-level). No-op if not supported. */
  microStep(): void;

  /** Run until a breakpoint or halt condition. No-op if not supported. */
  runToBreak(): void;

  /** DC operating-point analysis. Returns null if no analog domain. */
  dcOperatingPoint(): DcOpResult | null;

  /** AC sweep analysis. Returns null if not supported. */
  acAnalysis(params: AcParams): AcResult | null;

  /**
   * Current simulation time in seconds, or null if timing is purely discrete.
   * For mixed circuits, returns the analog engine's simTime.
   */
  readonly simTime: number | null;

  /**
   * Current engine lifecycle state (unified across backends).
   * RUNNING if any backend is RUNNING. ERROR if any backend is ERROR.
   */
  getState(): EngineState;

  // -------------------------------------------------------------------------
  // §1.3 Unified signal snapshot (replace _snapshotSignals branching)
  // -------------------------------------------------------------------------

  /**
   * Snapshot all signals for stability detection.
   * Returns a Float64Array covering all nets/nodes across both domains.
   * Digital nets occupy indices [0, digitalNetCount), analog nodes follow.
   */
  snapshotSignals(): Float64Array;

  /** Total number of signal slots (digital nets + analog nodes) for snapshot sizing. */
  readonly signalCount: number;

  /**
   * Timing model active in this coordinator.
   * - 'discrete': steps are unitless counts (digital). Speed = steps/s.
   * - 'continuous': steps advance simTime in seconds (analog). Speed = sim-s/wall-s.
   * - 'mixed': both timing models active; continuous dominates the render loop.
   */
  readonly timingModel: 'discrete' | 'continuous' | 'mixed';

  /**
   * Compute how many steps to execute this frame given wall-clock delta.
   * For discrete: uses steps/s rate.
   * For continuous/mixed: uses sim-s/wall-s rate + budget limiting.
   */
  computeFrameSteps(wallDtSeconds: number): FrameStepResult;

  /** Current speed setting. Units depend on timingModel (steps/s or sim-s/wall-s). */
  speed: number;

  /** Multiply speed by factor, clamped to valid range. */
  adjustSpeed(factor: number): void;

  /** Parse speed from text input and update. */
  parseSpeed(text: string): void;

  /** Format current speed for display. */
  formatSpeed(): { value: string; unit: string };

  // -------------------------------------------------------------------------
  // §1.5 Clock management
  // -------------------------------------------------------------------------

  /**
   * Advance all clock signals by one step.
   * No-op if no digital backend is active or no Clock components are present.
   */
  advanceClocks(): void;

  // -------------------------------------------------------------------------
  // §1.6 Visualization context (replace analog render setup in consumers)
  // -------------------------------------------------------------------------

  /**
   * Build a pin-voltage lookup for a specific element.
   * Returns a map of pinLabel -> voltage, or null if the element has no analog
   * domain representation (digital-only element or no analog backend).
   */
  getPinVoltages(element: CircuitElement): Map<string, number> | null;

  /**
   * Get the analog MNA node ID for a wire.
   * Returns undefined if the wire is digital or not in the analog domain.
   */
  getWireAnalogNodeId(wire: Wire): number | undefined;

  /**
   * Min/max voltage seen across all analog nodes since last reset.
   * Returns null if no analog domain is active.
   */
  readonly voltageRange: { min: number; max: number } | null;

  /**
   * Update voltage tracking after a step batch.
   * Iterates all analog nodes and extends the min/max range.
   * No-op if no analog domain is active.
   */
  updateVoltageTracking(): void;

  // -------------------------------------------------------------------------
  // §1.7 Slider context (replace analogCompiled.elementToCircuitElement iteration)
  // -------------------------------------------------------------------------

  /**
   * Get slider-eligible properties for an element.
   * Returns property descriptors for all FLOAT properties when the element
   * is present in the analog partition, or an empty array otherwise.
   */
  getSliderProperties(element: CircuitElement): SliderPropertyDescriptor[];

  /**
   * Update a component property at runtime (hot-patching the engine).
   * Calls setParam() on the element if supported, then triggers engine re-stamp.
   * No-op if the element is not in the analog domain or the engine is absent.
   */
  setComponentProperty(element: CircuitElement, key: string, value: number): void;

  // -------------------------------------------------------------------------
  // §1.8 Measurement signal reading (for AnalogScopePanel / TimingDiagramPanel)
  // -------------------------------------------------------------------------

  /**
   * Read element current by element index.
   * Returns null if not available (digital-only element or no analog domain).
   */
  readElementCurrent(elementIndex: number): number | null;

  /**
   * Read branch current by branch index.
   * Returns null if not available (no analog domain or index out of range).
   */
  readBranchCurrent(branchIndex: number): number | null;

  // -------------------------------------------------------------------------
  // §1.9 Snapshot management (for TimingDiagramPanel time-cursor scrubbing)
  // -------------------------------------------------------------------------

  /**
   * Save a snapshot of all engine state. Returns an opaque ID.
   * Delegates to the digital backend if present; analog snapshot support
   * is reserved for future extension.
   */
  saveSnapshot(): SnapshotId;

  /**
   * Restore engine state from a previously saved snapshot.
   * No-op if no digital backend is active or the ID is unknown.
   */
  restoreSnapshot(id: SnapshotId): void;

  // -------------------------------------------------------------------------
  // §1.10 Current resolver context (replace direct AnalogEngine reach-through)
  // -------------------------------------------------------------------------

  /**
   * Build current-resolver data for wire current animation.
   * Returns null if no analog domain is present.
   */
  getCurrentResolverContext(): CurrentResolverContext | null;
}

/**
 * Descriptor for a single slider-eligible property on an analog element.
 * Returned by coordinator.getSliderProperties().
 */
export interface SliderPropertyDescriptor {
  /** Index of the element in the compiled analog circuit. */
  elementIndex: number;
  /** Property key (e.g. "resistance", "capacitance"). */
  key: string;
  /** Human-readable label for the slider. */
  label: string;
  /** Current value of the property. */
  currentValue: number;
  /** SI unit string (e.g. "Ω", "F"). */
  unit: string;
  /** Whether the slider should use a logarithmic scale. */
  logScale: boolean;
}

/**
 * Context provided to WireCurrentResolver so it can compute per-wire currents
 * without importing AnalogEngine or ResolvedAnalogCircuit directly.
 *
 * The coordinator builds this from its internal analog backend and compiled
 * circuit; consumers (WireCurrentResolver, app-init) use this interface only.
 */
export interface CurrentResolverContext {
  /** Wire to MNA node ID mapping for the analog domain. */
  wireToNodeId: ReadonlyMap<Wire, number>;
  /** All analog element instances in stamping order. */
  elements: readonly AnalogElement[];
  /** Maps element index to the originating visual CircuitElement. */
  elementToCircuitElement: ReadonlyMap<number, CircuitElement>;
  /** Get per-pin currents for element at given index (positive = into element). */
  getElementPinCurrents(elementIndex: number): number[];
}
