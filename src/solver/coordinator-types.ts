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

import type { MeasurementObserver, SnapshotId } from "../core/engine-interface.js";
import { EngineState } from "../core/engine-interface.js";
import type { DcOpResult } from "../core/analog-engine-interface.js";
import type { Diagnostic, SignalAddress, SignalValue } from "../compile/types.js";
import type { AcParams, AcResult } from "./analog/ac-analysis.js";
import type { Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { AnalogElement } from "./analog/element.js";
import type { ResolvedPin } from "../core/pin.js";

/**
 * Result of computeFrameSteps — describes how to advance simulation this frame.
 *
 * simTimeGoal is the target simTime to reach; budgetMs limits wall time per frame.
 */
export interface FrameStepResult {
  /** Reserved (always 0 in continuous mode). */
  steps: number;
  /** The simTime goal to reach this frame. */
  simTimeGoal: number | null;
  /** Wall-clock budget in ms for stepping. */
  budgetMs: number;
  /** Whether the frame missed its target (couldn't keep up with requested speed). */
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
  // §1.1 Capability queries
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
   * Step until simTime >= targetSimTime, with optional wall-clock budget.
   * Returns the number of steps taken. No-op (returns 0) for discrete-only circuits.
   * @param targetSimTime - Target simulation time in seconds
   * @param budgetMs - Wall-clock budget in milliseconds (default 5000)
   */
  stepToTime(targetSimTime: number, budgetMs?: number): Promise<number>;

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
   * - 'discrete': digital-only (legacy, not used in UI).
   * - 'continuous': analog or mixed-signal. Speed = sim-s/wall-s.
   * - 'mixed': both digital and analog backends active.
   */
  readonly timingModel: 'discrete' | 'continuous' | 'mixed';

  /**
   * Compute how to advance simulation this frame given wall-clock delta.
   * Uses sim-s/wall-s rate with budget limiting.
   */
  computeFrameSteps(wallDtSeconds: number): FrameStepResult;

  /**
   * Ensure _simTimeTarget >= simTime so the render loop does not stall
   * after a stepToTime() call that jumped ahead of the accumulated target.
   */
  syncTimeTarget(): void;

  /**
   * Register a breakpoint at the given simulation time so the analog engine
   * lands exactly on it during normal render-loop stepping.
   */
  addTimeBreakpoint(time: number): void;

  /** Current speed setting in sim-seconds per wall-second. */
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
   * Routes to setParam() for analog elements and layout.setProperty() for
   * digital components. Triggers engine re-stamp for analog domain.
   */
  setComponentProperty(element: CircuitElement, key: string, value: number): void;

  /**
   * Set an analog source parameter by component label.
   *
   * Resolves the label to a CircuitElement via labelToCircuitElement,
   * then calls setComponentProperty to re-stamp the MNA matrix.
   * If paramKey is not provided, the primary parameter is determined from
   * modelRegistry.behavioral.paramDefs[0]. If the label is not found or
   * has no analog representation, this is a no-op.
   *
   * @param label     Component label (e.g. "Vdc", "Iin")
   * @param paramKey  Parameter key to set (e.g. "voltage", "current")
   * @param value     New parameter value
   */
  setSourceByLabel(label: string, paramKey: string, value: number): void;

  // -------------------------------------------------------------------------
  // §1.8 Measurement signal reading (for ScopePanel)
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

  /**
   * Read element power by element index.
   * Returns null if not available (digital-only element or no analog domain).
   */
  readElementPower(elementIndex: number): number | null;

  // -------------------------------------------------------------------------
  // §1.9 Snapshot management (for TimingDiagramPanel time-cursor scrubbing)
  // -------------------------------------------------------------------------

  /**
   * Save a snapshot of all engine state. Returns an opaque ID.
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
  /**
   * All visual CircuitElements in the circuit (including non-analog elements
   * such as Tunnels). Used for tunnel-vertex detection in current propagation.
   */
  circuitElements: readonly CircuitElement[];
  /**
   * Compiler-resolved wire vertices for each element pin.
   * When present, used directly instead of re-computing pin positions.
   */
  elementPinVertices?: ReadonlyMap<number, Array<{ x: number; y: number } | null>>;
  /**
   * Compiler-resolved pins in pinLayout order (label, vertex, nodeId).
   * When present, preferred over elementPinVertices and pinWorldPosition calls.
   */
  elementResolvedPins?: ReadonlyMap<number, ResolvedPin[]>;
}
