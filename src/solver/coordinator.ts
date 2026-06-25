/**
 * DefaultSimulationCoordinator -- unified coordinator for all circuit types.
 *
 * Wraps digital and analog backends with bridge synchronisation between
 * domains. Provides a single stepping interface regardless of which backends
 * are active, and notifies registered MeasurementObservers after each step.
 *
 * Top-level bridge adapters (compiled.bridges) handle per-net digital-analog
 * crossings using threshold detection and breakpoint-driven analog stepping.
 *
 * Spec: unified-component-architecture.md Section 5 (Phase 4, P4-2/P4-6).
 */

import type { SimulationEngine, MeasurementObserver, SnapshotId } from '../core/engine-interface.js';
import { EngineState } from '../core/engine-interface.js';
import type { AnalogEngine, DcOpResult, SimulationParams, TfParams, TfResult } from '../core/analog-engine-interface.js';
import { DigitalEngine } from './digital/digital-engine.js';
import type { ConcreteCompiledCircuit } from './digital/digital-engine.js';
import { ClockManager } from './digital/clock.js';
import type { CompiledCircuitImpl as CompiledDigitalDomain } from './digital/compiled-circuit.js';
import { MNAEngine } from './analog/analog-engine.js';
import type { StepRecord } from './analog/convergence-log.js';
import { BitVector } from '../core/signal.js';
import { FacadeError } from '../headless/types.js';
import { DiagnosticCollector } from './analog/diagnostics.js';
import type { LimitingEvent } from './analog/newton-raphson.js';
import type { Diagnostic } from '../compile/types.js';
import type { SimulationCoordinator, FrameStepResult, CurrentResolverContext, SliderPropertyDescriptor, PhaseAwareCaptureHook } from './coordinator-types.js';
import type { CircuitElement } from '../core/element.js';
import type { Wire } from '../core/circuit.js';
import type { AcParams, AcResult } from './analog/ac-analysis.js';
import type {
  CompiledCircuitUnified,
  BridgeAdapter,
  SignalAddress,
  SignalValue,
} from '../compile/types.js';
import type { ConcreteCompiledAnalogCircuit } from './analog/compiled-analog-circuit.js';
import type { BridgePinAdapterHandle } from './analog/compiler.js';
import type { ComponentRegistry } from '../core/registry.js';
import { PropertyType } from '../core/properties.js';

/** SI unit strings for common analog property keys. */
const ANALOG_PROPERTY_UNITS: Record<string, string> = {
  resistance: '\u03A9',
  capacitance: 'F',
  inductance: 'H',
  voltage: 'V',
  current: 'A',
  frequency: 'Hz',
};

/**
 * Per-bridge-adapter state for top-level digital↔analog bridges.
 * Tracks previous bit for hysteresis in the indeterminate voltage band
 * (analog→digital direction) and the previous logic level fed to the
 * analog stamp (digital→analog direction) so edge transitions can post
 * an analog breakpoint and avoid trapezoidal ringing across the
 * discontinuity.
 */
interface TopLevelBridgeState {
  prevBit: number;
  prevDaHigh: boolean;
  /** Previous enable state fed to an output adapter (true = driven, false =
   *  Hi-Z released). A driven→Hi-Z release at the same logic level still posts
   *  an analog breakpoint, so the timestep controller lands on the release. */
  prevDaEn: boolean;
}

export class DefaultSimulationCoordinator implements SimulationCoordinator {
  private readonly _compiled: CompiledCircuitUnified;
  private readonly _digital: SimulationEngine | null;
  private readonly _analog: AnalogEngine | null;
  private readonly _bridges: BridgeAdapter[];
  private readonly _topLevelBridgeStates: TopLevelBridgeState[];
  /** Resolved per-pin boundary adapter handle parallel to _bridges. Index i →
   *  the handle for _bridges[i] (one crossing pin), or null if unresolved. */
  private readonly _resolvedBridgeAdapters: Array<BridgePinAdapterHandle | null>;
  private readonly _clockManager: ClockManager | null;
  private _diagnostics: DiagnosticCollector | null = null;
  private readonly _observers: Set<MeasurementObserver> = new Set();
  private _stepCount = 0;
  private readonly _timingModel: 'discrete' | 'continuous' | 'mixed';
  /** Simulation speed in sim-s/wall-s. */
  private _analogSpeed: number = 1e-3;
  private _simTimeTarget: number = 0;
  private _voltageMin: number = Infinity;
  private _voltageMax: number = -Infinity;
  private readonly _registry: ComponentRegistry | null;
  /** Lazily-built inverted index: CircuitElement → analog element index. */
  private _elementIndexCache: Map<CircuitElement, number> | null = null;
  /** Lazily-built inverted index: CircuitElement → digital component index. */
  private _digitalElementIndexCache: Map<CircuitElement, number> | null = null;
  /** Reusable Map for getPinVoltages() to avoid per-call allocation. */
  private readonly _pinVoltageResult = new Map<string, number>();
  private _analysisPhase: "dcop" | "tranInit" | "tranFloat" = "dcop";
  private _convergenceLogPreHookState: boolean = false;
  private _captureHookInstalled: boolean = false;
  /** Accumulates limiting events across all NR iterations during setLimitingCapture capture. */
  private _limitingAccumulator: LimitingEvent[] | null = null;
  /**
   * Per-circuit solver overrides (presence = given). Applied to the analog
   * engine at construction; a given maxTimeStep is re-asserted by the streaming
   * push so the speed-derived outputStep cannot strip it.
   */
  private readonly _solverSettings: Partial<SimulationParams>;

  constructor(compiled: CompiledCircuitUnified, registry?: ComponentRegistry, solverSettings?: Partial<SimulationParams>) {
    this._registry = registry ?? null;
    this._compiled = compiled;
    this._solverSettings = solverSettings ?? {};
    this._bridges = compiled.bridges;
    this._topLevelBridgeStates = compiled.bridges.map(() => ({ prevBit: 0, prevDaHigh: false, prevDaEn: true }));

    // Resolve one per-pin boundary adapter handle per bridge (each bridge is a
    // single crossing pin) from bridgeAdaptersByPinKey. No .find() scan: the
    // map is keyed by the same pinKey the BridgeAdapter carries.
    if (compiled.analog !== null) {
      const compiledAnalog = compiled.analog as ConcreteCompiledAnalogCircuit;
      this._resolvedBridgeAdapters = compiled.bridges.map(
        (bridge) => compiledAnalog.bridgeAdaptersByPinKey.get(bridge.pinKey) ?? null,
      );
    } else {
      this._resolvedBridgeAdapters = compiled.bridges.map(() => null);
    }

    if (compiled.digital !== null) {
      const engine = new DigitalEngine('level');
      engine.init(compiled.digital);
      this._digital = engine;
    } else {
      this._digital = null;
    }

    if (compiled.analog !== null) {
      const engine = new MNAEngine();
      engine.init(compiled.analog);
      this._analog = engine;
      // Apply per-circuit solver overrides (tolerances, gmin, OPtran, temp,
      // indVerbosity, a given maxTimeStep). The streaming push below re-asserts
      // a given maxTimeStep so the speed-derived outputStep cannot strip it.
      if (Object.keys(this._solverSettings).length > 0) {
        engine.configure(this._solverSettings);
      }
    } else {
      this._analog = null;
    }

    if (compiled.digital !== null && compiled.analog !== null) {
      this._timingModel = 'mixed';
    } else if (compiled.analog !== null) {
      this._timingModel = 'continuous';
    } else {
      this._timingModel = 'discrete';
    }

    this._clockManager = compiled.digital !== null
      ? new ClockManager(compiled.digital as ConcreteCompiledCircuit)
      : null;

    if (this._analog !== null) {
      const mnaEngine = this._analog as MNAEngine;
      if (typeof mnaEngine.onDiagnostic === 'function') {
        this._diagnostics = this._createDiagnosticProxy();
        // Mirror engine-emitted diagnostics into the coordinator's collector
        // so consumers see post-setup topology codes, convergence-failed, and
        // reactive-state-outside-pool through a single channel
        // (coordinator.getRuntimeDiagnostics()) without reaching into the engine.
        mnaEngine.onDiagnostic((d) => {
          this._diagnostics?.emit(d);
        });
      }
    }

    this._pushAnalogStreamingParams();
  }

  /**
   * Push speed-derived transient parameters to the analog engine.
   *
   * Streaming-mode UI has no fixed tStop, so we pass Infinity and let
   * resolveSimulationParams derive maxTimeStep, firstStep, and minTimeStep
   * from outputStep. outputStep targets ~60 sample points per wall-second
   * at the current display speed, which both gives the render loop a
   * sensible per-frame step budget and keeps maxTimeStep proportional to
   * the time horizon the user is actually watching.
   *
   * Without this call the engine runs with DEFAULT_SIMULATION_PARAMS
   * (firstStep=1e-9, maxTimeStep=10e-6, finalTime=Infinity), which
   * mismatches every circuit whose interesting dynamics live outside
   * that ratio.
   */
  private _pushAnalogStreamingParams(): void {
    if (this._analog === null) return;
    const outputStep = Math.max(1e-12, this._analogSpeed / 60);
    const cfg: Partial<SimulationParams> = {
      tStop: Number.POSITIVE_INFINITY,
      outputStep,
      initTime: 0,
    };
    // A user-given maxTimeStep is a hard ceiling: re-assert it on every speed
    // push so resolveSimulationParams keeps it (analog-engine.ts:1724 only
    // strips maxTimeStep when the call omits it) instead of deriving from
    // outputStep. Absent (not given) => the live step follows playback speed.
    const givenMax = this._solverSettings.maxTimeStep;
    if (givenMax != null && givenMax !== 0) cfg.maxTimeStep = givenMax;
    this._analog.configure(cfg);
  }

  get compiled(): CompiledCircuitUnified { return this._compiled; }

  /**
   * Returns the internal digital engine for use by solver-internal code only.
   * Consumers must not call this- use capability queries and coordinator methods.
   */
  getDigitalEngine(): SimulationEngine | null { return this._digital; }

  /**
   * Returns the internal analog engine for use by solver-internal code only.
   * Consumers must not call this- use readSignal, readElementCurrent, etc.
   */
  getAnalogEngine(): AnalogEngine | null { return this._analog; }

  start(): void {
    this._digital?.start();
    this._analog?.start();
  }
  stop(): void { this._digital?.stop(); this._analog?.stop(); }

  reset(): void {
    this._digital?.reset();
    this._analog?.reset();
    for (const state of this._topLevelBridgeStates) {
      state.prevBit = 0;
      state.prevDaHigh = false;
    }
    this._stepCount = 0;
    this._voltageMin = Infinity;
    this._voltageMax = -Infinity;
    this._analysisPhase = "dcop";
    for (const obs of this._observers) obs.onReset();
  }

  dispose(): void {
    this._digital?.dispose();
    this._analog?.dispose();
    this._observers.clear();
  }

  step(): void {
    // The warm-start transient DCOP (ngspice dctran.c:230-360 firsttime block)
    // is owned by MNAEngine.step()- it runs the DCOP and falls through into
    // the first transient iteration on the first call after init/reset, then
    // skips the DCOP on subsequent calls. The coordinator is the digital/
    // analog bridge layer and has no ngspice analog here.
    if (this._analog !== null && this._analysisPhase === "dcop") {
      this._analysisPhase = "tranInit";
    }

    if (this._digital !== null && this._analog !== null) {
      this._stepMixed();
    } else if (this._digital !== null) {
      this._digital.step();
    } else if (this._analog !== null) {
      this._analog.step();
    }

    // Convergence failures are reported by the engine itself: it emits a
    // structured `convergence-failed` Diagnostic into the shared collector
    // and transitions to EngineState.ERROR before returning. Callers query
    // those (state + getRuntimeDiagnostics()) — no exception path here.

    // ngspice clears MODEINITTRAN after the first accepted transient step,
    // regardless of integration order.  Our tranInit→tranFloat transition
    // should match: advance after the first successful transient step, not
    // wait for order promotion to trapezoidal.
    if (this._analog !== null && this._analysisPhase === "tranInit") {
      if (this._stepCount >= 1) {
        this._analysisPhase = "tranFloat";
      }
    }

    this._stepCount++;
    for (const obs of this._observers) obs.onStep(this._stepCount);
  }

  /**
   * Mixed-signal step: both digital and analog backends are active.
   * Uses BridgeAdapter descriptors (compiled.bridges) for the top-level
   * digital-analog net/node mapping.
   */
  private _stepMixed(): void {
    const digital = this._digital!;
    const analog = this._analog!;

    if (this._bridges.length === 0) {
      digital.step();
      analog.step();
      return;
    }

    const digitalEngine = digital as DigitalEngine;

    // A2D: for each crossing INPUT pin, read its adapter's result-node voltage
    // and threshold to a bit. The inner DigitalInputPin emits {0,0.5,1}; the
    // coordinator maps 0.5 → hold-last-bit (preserving today's hysteresis).
    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.role !== 'input') continue;
      const handle = this._resolvedBridgeAdapters[i];
      if (handle === null || handle.resultNodeId < 0) {
        this._diagnostics?.emit({
          code: 'bridge-missing-inner-pin',
          severity: 'error',
          message: `No input boundary adapter for crossing pin ${bridge.pinKey}`,
          explanation: 'An analog→digital crossing pin has no resolved boundary adapter result node. This indicates a compilation error- the adapter was not fully assembled.',
          suggestions: [],
        });
        continue;
      }
      const result = analog.getNodeVoltage(handle.resultNodeId);
      let bit: number;
      if (result > 0.5) {
        bit = 1;
        this._topLevelBridgeStates[i]!.prevBit = 1;
      } else if (result < 0.5) {
        bit = 0;
        this._topLevelBridgeStates[i]!.prevBit = 0;
      } else {
        bit = this._topLevelBridgeStates[i]!.prevBit;
      }
      digital.setSignalValue(bridge.digitalNetId, BitVector.fromNumber(bit, bridge.bitWidth));
    }

    // Pre-clear each crossing OUTPUT pin's net to "driven" (Hi-Z flag = 0)
    // BEFORE evaluating the digital engine. Net Hi-Z slots default to the
    // UNDEFINED sentinel (0xFFFFFFFF) and plain gates never touch them, so
    // without this a gate-driven boundary net reads as Hi-Z and the adapter
    // wrongly releases the hub. A tri-state Driver re-asserts Hi-Z during
    // digital.step() when sel deselects it, so genuine releases still register.
    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.role !== 'output') continue;
      digitalEngine.markNetDriven(bridge.digitalNetId);
    }

    digital.step();

    // D2A: for each crossing OUTPUT pin, drive ctrl from the digital level and
    // en from the net's Hi-Z flag. en=0 releases the hub through rHiZ; only a
    // tri-state driver (e.g. Driver with sel=0) re-asserts Hi-Z after the
    // pre-clear above, so a plain gate keeps en=1 (sEn closed).
    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.role !== 'output') continue;
      const raw = digital.getSignalRaw(bridge.digitalNetId);
      const hiZ = digitalEngine.getSignalHighZ(bridge.digitalNetId) !== 0;
      const high = raw !== 0;
      const en = !hiZ;
      const state = this._topLevelBridgeStates[i]!;
      // On a logic-level OR enable transition, post an analog breakpoint at the
      // current analog simTime. The next getClampedDt sees almostEqualUlps and
      // applies the at-breakpoint clamp (CKTorder = 1, dt clamped via
      // saveDelta), so the analog engine takes a clean order-1 small-dt step
      // across the discontinuity instead of trapezoidal-integrating through a
      // jump in the adapter's drive/Hi-Z. Mirrors the CKTsetBreak pattern used
      // by every analog source (pulse, clock, pwl). A driven→Hi-Z release at
      // the same logic level still posts a breakpoint via the en transition.
      if (high !== state.prevDaHigh || en !== state.prevDaEn) {
        analog.addBreakpoint(analog.simTime);
        state.prevDaHigh = high;
        state.prevDaEn = en;
      }
      const handle = this._resolvedBridgeAdapters[i];
      if (handle !== null) {
        // ctrl: normalized logic level {0,1}; en: 1=driven, 0=Hi-Z.
        handle.wrapper.setParam('ctrl', high ? 1 : 0);
        handle.wrapper.setParam('en', en ? 1 : 0);
      }
    }

    analog.step();
  }

  /**
   * One-step digital warmup for standalone DC-op. Evaluates the digital engine
   * and pushes each crossing OUTPUT pin's logic level (ctrl) and Hi-Z (en) onto
   * its boundary adapter, so the analog operating point reflects real drive vs
   * release instead of the adapter's drive-low defaults. Mirrors the output half
   * of _stepMixed's D2A sync (no breakpoints- there is no transient timeline at
   * a bias point). Input bridges need no warmup: their adapters are passive in
   * the analog solve, which resolves the result node from the hub voltage.
   */
  private _digitalWarmupForDcOp(): void {
    if (this._digital === null || this._bridges.length === 0) return;
    const digital = this._digital;
    const digitalEngine = digital as DigitalEngine;
    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.role !== 'output') continue;
      digitalEngine.markNetDriven(bridge.digitalNetId);
    }
    digital.step();
    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.role !== 'output') continue;
      const handle = this._resolvedBridgeAdapters[i];
      if (handle === null) continue;
      const high = digital.getSignalRaw(bridge.digitalNetId) !== 0;
      const en = digitalEngine.getSignalHighZ(bridge.digitalNetId) === 0;
      handle.wrapper.setParam('ctrl', high ? 1 : 0);
      handle.wrapper.setParam('en', en ? 1 : 0);
    }
  }

  readSignal(addr: SignalAddress): SignalValue {
    if (addr.domain === 'digital') {
      if (this._digital === null) throw new FacadeError('No digital backend available for readSignal');
      return { type: 'digital', value: this._digital.getSignalRaw(addr.netId) };
    }
    if (this._analog === null) throw new FacadeError('No analog backend available for readSignal');
    return { type: 'analog', voltage: this._analog.getNodeVoltage(addr.nodeId) };
  }

  writeSignal(addr: SignalAddress, value: SignalValue): void {
    if (addr.domain === 'digital') {
      if (this._digital === null) throw new FacadeError('No digital backend available for writeSignal');
      if (value.type !== 'digital') throw new FacadeError('Cannot write analog SignalValue to digital address');
      this._digital.setSignalValue(addr.netId, BitVector.fromNumber(value.value, addr.bitWidth));
      return;
    }
    if (this._analog === null) throw new FacadeError('No analog backend available for writeSignal');
    if (value.type !== 'analog') throw new FacadeError('Cannot write digital SignalValue to analog address');
    this._analog.setNodeVoltage(addr.nodeId, value.voltage);
  }

  readByLabel(label: string): SignalValue {
    const addr = this._compiled.labelSignalMap.get(label);
    if (addr === undefined) throw new FacadeError('Label "' + label + '" not found in compiled circuit');
    return this.readSignal(addr);
  }

  writeByLabel(label: string, value: SignalValue): void {
    const addr = this._compiled.labelSignalMap.get(label);
    if (addr === undefined) throw new FacadeError('Label "' + label + '" not found in compiled circuit');
    this.writeSignal(addr, value);
  }

  readAllSignals(): Map<string, SignalValue> {
    const result = new Map<string, SignalValue>();
    for (const [label, addr] of this._compiled.labelSignalMap) result.set(label, this.readSignal(addr));
    return result;
  }

  addMeasurementObserver(observer: MeasurementObserver): void { this._observers.add(observer); }
  removeMeasurementObserver(observer: MeasurementObserver): void { this._observers.delete(observer); }

  supportsMicroStep(): boolean { return this._digital !== null; }
  supportsRunToBreak(): boolean { return this._digital !== null; }
  supportsAcSweep(): boolean { return this._analog !== null; }
  supportsDcOp(): boolean { return this._analog !== null; }
  supportsTf(): boolean { return this._analog !== null; }

  microStep(): void {
    if (this._digital !== null) this._digital.microStep();
  }

  runToBreak(): void {
    if (this._digital !== null) this._digital.runToBreak();
  }

  /**
   * Current analysis phase, updated at each step boundary.
   * "dcop"     - DC operating point (initial or re-solve)
   * "tranInit" - Transient initialization (first few steps at t=0)
   * "tranFloat"- Transient free-running (t > 0)
   */
  get analysisPhase(): "dcop" | "tranInit" | "tranFloat" {
    return this._analysisPhase;
  }

  applyCaptureHook(bundle: PhaseAwareCaptureHook | null): void {
    if (!this._analog) return;
    const e = this._analog as MNAEngine;

    if (bundle === null) {
      e.postIterationHook = null;
      e.preFactorHook = null;
      e.stepPhaseHook = null;
      e.detailedConvergence = false;
      e.limitingCollector = null;
      e.convergenceLog.enabled = this._convergenceLogPreHookState;
      this._captureHookInstalled = false;
      return;
    }

    if (!this._captureHookInstalled) {
      this._convergenceLogPreHookState = e.convergenceLog.enabled;
    }
    e.postIterationHook = bundle.iterationHook;
    e.preFactorHook = bundle.preFactorHook ?? null;
    e.stepPhaseHook = bundle.phaseHook;
    e.detailedConvergence = true;
    e.limitingCollector = [];
    e.convergenceLog.enabled = true;
    this._captureHookInstalled = true;
  }

  /**
   * Run the analog structural setup pass without any analysis (no DC-OP, no
   * transient step). Triggers `MNAEngine._setup()`, which allocates the matrix
   * and runs the post-setup topology detectors; their diagnostics surface
   * through `getRuntimeDiagnostics()` via the engine's `onDiagnostic` mirror.
   * No-op for digital-only circuits (no analog backend). Phase-neutral: unlike
   * `dcOperatingPoint()` it does not park the engine in the `dcop` phase, so the
   * first transient `step()` still runs the warm-start MODETRANOP cleanly.
   */
  prepareSetup(): void {
    this._analog?.prepareSetup();
  }

  /**
   * Standalone DC operating-point analysis (matches ngspice `.op` →
   * `dcop.c::DCop` → `CKTop(MODEDCOP|MODEINITJCT, MODEDCOP|MODEINITFLOAT)`).
   * Each invocation runs a fresh DCOP- ngspice rebuilds the bias point
   * for every `.op` directive and does not reuse cached results across
   * jobs. Distinct from the transient-boot DCOP that step() lazily runs
   * (which uses MODETRANOP and only seeds transient state).
   */
  dcOperatingPoint(): DcOpResult | null {
    if (this._analog === null) return null;
    this._analysisPhase = "dcop";
    // One-step digital warmup: a standalone .op has not run the transient mixed
    // step, so without this the boundary OUTPUT adapters sit at their drive-low
    // defaults and corrupt the bias point (e.g. a Const-disabled Driver would
    // still pin the hub). Evaluate the digital engine once and push each
    // crossing output pin's level/Hi-Z onto its adapter before the analog solve.
    this._digitalWarmupForDcOp();
    return (this._analog as MNAEngine).dcOperatingPoint();
  }

  acAnalysis(params: AcParams): AcResult | null {
    if (this._analog === null) return null;
    return this._analog.acAnalysis(params);
  }

  /**
   * DC transfer-function analysis (ngspice `.tf` → tfanal.c TFanal). Forwards
   * to the analog engine, which runs a fresh DC-OP to factor the Jacobian and
   * then re-solves it with unit input/output excitations. Returns null when no
   * analog backend is present.
   */
  transferFunction(params: TfParams): TfResult | null {
    if (this._analog === null) return null;
    this._analysisPhase = "dcop";
    return this._analog.transferFunction(params);
  }

  // -------------------------------------------------------------------------
  // Convergence logging
  // -------------------------------------------------------------------------

  getElementLabel(index: number): string | undefined {
    if (this._analog === null) return undefined;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    const circEl = compiledAnalog.elementToCircuitElement.get(index);
    if (!circEl) return undefined;
    const label = circEl.getProperties().has("label")
      ? String(circEl.getProperties().get("label") ?? circEl.instanceId)
      : circEl.instanceId;
    return `${label} (${circEl.typeId})`;
  }

  supportsConvergenceLog(): boolean { return this._analog !== null; }

  setConvergenceLogEnabled(enabled: boolean): void {
    if (this._captureHookInstalled && enabled === false) {
      throw new Error(
        "Cannot disable convergence log while a comparison harness capture hook is installed. " +
        "Call setCaptureHook(null) first."
      );
    }
    if (this._analog === null) return;
    this._analog.convergenceLog.enabled = enabled;
  }

  getConvergenceLog(lastN?: number): StepRecord[] | null {
    if (this._analog === null) return null;
    const log = this._analog.convergenceLog;
    return lastN !== undefined ? log.getLast(lastN) : log.getAll();
  }

  clearConvergenceLog(): void {
    if (this._analog === null) return;
    this._analog.convergenceLog.clear();
  }

  setCircuitTemp(K: number): void {
    if (this._analog === null) return;
    this._analog.setCircuitTemp(K);
  }

  configure(params: Partial<SimulationParams>): void {
    if (this._analog === null) return;
    this._analog.configure(params);
  }

  async stepToTime(targetSimTime: number, budgetMs = 5000): Promise<number> {
    if (this._analog === null) return 0;
    this._analog.addBreakpoint(targetSimTime);
    const wallStart = performance.now();
    let count = 0;
    const FRAME_BUDGET_MS = 12;

    while ((this._analog.simTime ?? 0) < targetSimTime) {
      if (performance.now() - wallStart > budgetMs) break;

      const chunkStart = performance.now();
      while ((this._analog.simTime ?? 0) < targetSimTime) {
        if (performance.now() - chunkStart > FRAME_BUDGET_MS) break;
        if (performance.now() - wallStart > budgetMs) break;
        this.step();
        count++;
      }

      await new Promise<void>(resolve => setTimeout(resolve, 0));

      if (this.getState() === EngineState.ERROR) break;
    }
    return count;
  }

  async sampleAtTimes<T>(
    times: readonly number[],
    capture: () => T,
    wallBudgetMs = 30_000,
  ): Promise<readonly T[]> {
    if (this._analog === null) return [];
    if (times.length === 0) return [];

    // Validate monotonically increasing
    for (let i = 1; i < times.length; i++) {
      if (times[i]! <= times[i - 1]!) {
        throw new Error(
          `sampleAtTimes: times must be monotonically increasing. ` +
          `times[${i - 1}]=${times[i - 1]} >= times[${i}]=${times[i]}`,
        );
      }
    }

    // Register all target times as breakpoints up front (dedup is handled by addBreakpoint)
    for (const t of times) {
      this._analog.addBreakpoint(t);
    }

    const results: T[] = [];
    const wallStart = performance.now();

    for (const target of times) {
      while ((this._analog.simTime ?? 0) < target) {
        if (performance.now() - wallStart > wallBudgetMs) {
          throw new Error(
            `sampleAtTimes: wall-clock budget of ${wallBudgetMs}ms exceeded at simTime=${this._analog.simTime} (target=${target})`,
          );
        }
        if (this.getState() === EngineState.ERROR) {
          throw new Error(`sampleAtTimes: engine entered ERROR state at simTime=${this._analog.simTime}`);
        }
        this.step();
      }
      results.push(capture());
    }

    return results;
  }

  get simTime(): number | null {
    return this._analog !== null ? this._analog.simTime : null;
  }

  /** Restore analog sim time (used by hot-recompile). No-op if no analog engine. */
  setSimTime(t: number): void {
    if (this._analog === null) return;
    this._analog.setSimTime(t);
    this._simTimeTarget = t;
  }

  getState(): EngineState {
    const digitalState = this._digital?.getState();
    const analogState = this._analog?.getState();
    if (digitalState === EngineState.ERROR || analogState === EngineState.ERROR) return EngineState.ERROR;
    if (digitalState === EngineState.RUNNING || analogState === EngineState.RUNNING) return EngineState.RUNNING;
    if (digitalState === EngineState.PAUSED || analogState === EngineState.PAUSED) return EngineState.PAUSED;
    return EngineState.STOPPED;
  }

  get signalCount(): number {
    const digitalCount = this._compiled.digital?.netCount ?? 0;
    const analogCount = this._analog !== null
      ? (this._compiled.analog as ConcreteCompiledAnalogCircuit).nodeCount
      : 0;
    return digitalCount + analogCount;
  }

  snapshotSignals(): Float64Array {
    const count = this.signalCount;
    const snapshot = new Float64Array(count);
    const digitalCount = this._compiled.digital?.netCount ?? 0;
    if (this._digital !== null) {
      for (let i = 0; i < digitalCount; i++) {
        snapshot[i] = this._digital.getSignalRaw(i);
      }
    }
    if (this._analog !== null) {
      const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
      for (let i = 0; i < compiledAnalog.nodeCount; i++) {
        snapshot[digitalCount + i] = this._analog.getNodeVoltage(i + 1);
      }
    }
    return snapshot;
  }

  get timingModel(): 'discrete' | 'continuous' | 'mixed' {
    return this._timingModel;
  }

  get speed(): number {
    return this._analogSpeed;
  }

  set speed(value: number) {
    this._analogSpeed = Math.max(1e-9, value);
    this._syncTargetOnSpeedChange();
    this._pushAnalogStreamingParams();
  }

  adjustSpeed(factor: number): void {
    this._analogSpeed = Math.max(1e-9, this._analogSpeed * factor);
    this._syncTargetOnSpeedChange();
    this._pushAnalogStreamingParams();
  }

  parseSpeed(text: string): void {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed > 0) {
      this._analogSpeed = parsed;
      this._syncTargetOnSpeedChange();
      this._pushAnalogStreamingParams();
    }
  }

  /** Reset accumulated time target on speed change so debt doesn't carry over. */
  private _syncTargetOnSpeedChange(): void {
    const simTime = this._analog?.simTime ?? 0;
    if (this._simTimeTarget > simTime) {
      this._simTimeTarget = simTime;
    }
  }

  formatSpeed(): { value: string; unit: string } {
    const rate = this._analogSpeed;
    if (rate >= 1) return { value: String(rate), unit: 's/s' };
    if (rate >= 1e-3) return { value: String(rate * 1_000), unit: 'ms/s' };
    if (rate >= 1e-6) return { value: String(rate * 1_000_000), unit: '\u00b5s/s' };
    return { value: String(rate * 1e9), unit: 'ns/s' };
  }

  computeFrameSteps(wallDtSeconds: number): FrameStepResult {
    if (this._analog === null) {
      // Digital-only: no continuous time model, step once per frame
      return { steps: 0, simTimeGoal: null, budgetMs: 12, missed: false };
    }
    const clampedDt = Math.min(wallDtSeconds, 0.1);
    this._simTimeTarget += this._analogSpeed * clampedDt;
    return {
      steps: 0,
      simTimeGoal: this._simTimeTarget,
      budgetMs: 12,
      missed: false,
    };
  }

  syncTimeTarget(): void {
    const simTime = this._analog?.simTime ?? 0;
    if (simTime > this._simTimeTarget) {
      this._simTimeTarget = simTime;
    }
  }

  addTimeBreakpoint(time: number): void {
    this._analog?.addBreakpoint(time);
  }

  advanceClocks(): void {
    if (this._clockManager === null || this._digital === null) return;
    this._clockManager.advanceClocks((this._digital as DigitalEngine).getSignalArray());
  }

  setSnapshotBudget(bytes: number): void {
    if (this._digital === null) return;
    (this._digital as DigitalEngine).setSnapshotBudget(bytes);
  }

  /** Resolve CircuitElement → compiled element index via cached inverted map. */
  private _resolveElementIndex(element: CircuitElement): number {
    if (this._elementIndexCache === null) {
      this._elementIndexCache = new Map();
      const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
      for (const [idx, el] of compiledAnalog.elementToCircuitElement) {
        this._elementIndexCache.set(el, idx);
      }
    }
    return this._elementIndexCache.get(element) ?? -1;
  }

  getPinVoltages(element: CircuitElement): Map<string, number> | null {
    if (this._analog === null) return null;
    const elementIndex = this._resolveElementIndex(element);
    if (elementIndex === -1) return null;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    const resolvedPins = compiledAnalog.elementResolvedPins.get(elementIndex);
    if (resolvedPins === undefined || resolvedPins.length === 0) return null;
    // Reuse a single Map to avoid per-call allocation in the hot render path.
    const result = this._pinVoltageResult;
    result.clear();
    for (const pin of resolvedPins) {
      result.set(pin.label, this._analog.getNodeVoltage(pin.nodeId));
    }
    return result;
  }

  getWireAnalogNodeId(wire: Wire): number | undefined {
    if (this._analog === null) return undefined;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    return compiledAnalog.wireToNodeId.get(wire);
  }

  get voltageRange(): { min: number; max: number } | null {
    if (this._analog === null) return null;
    if (this._voltageMin === Infinity) return { min: 0, max: 0 };
    return { min: this._voltageMin, max: this._voltageMax };
  }

  updateVoltageTracking(): void {
    if (this._analog === null) return;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    for (let i = 1; i <= compiledAnalog.nodeCount; i++) {
      const v = this._analog.getNodeVoltage(i);
      if (v < this._voltageMin) this._voltageMin = v;
      if (v > this._voltageMax) this._voltageMax = v;
    }
  }

  getCurrentResolverContext(): CurrentResolverContext | null {
    if (this._analog === null) return null;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    const analog = this._analog;
    return {
      wireToNodeId: compiledAnalog.wireToNodeId,
      elements: compiledAnalog.elements,
      elementToCircuitElement: compiledAnalog.elementToCircuitElement,
      circuitElements: this._compiled.allCircuitElements,
      elementPinVertices: compiledAnalog.elementPinVertices,
      elementResolvedPins: compiledAnalog.elementResolvedPins,
      getElementPinCurrents(elementIndex: number): number[] {
        return analog.getElementPinCurrents(elementIndex);
      },
    };
  }

  getSliderProperties(element: CircuitElement): SliderPropertyDescriptor[] {
    if (this._analog === null || this._registry === null) return [];
    const elementIndex = this._resolveElementIndex(element);
    if (elementIndex === -1) return [];
    const def = this._registry.getStandalone(element.typeId);
    if (!def) return [];
    const bag = element.getProperties();
    const result: SliderPropertyDescriptor[] = [];

    // Model params (primary source of tunable analog parameters).
    // Bag may not have "model" set (e.g. resistor/inductor/capacitor/MOSFET
    // unless the user picked a model explicitly); skip model params in that case
    // rather than throwing from PropertyBag.get.
    const modelKey = bag.has("model") ? bag.get<string>("model") : "";
    const entry = modelKey ? def.modelRegistry?.[modelKey] : undefined;
    if (entry?.paramDefs) {
      for (const pd of entry.paramDefs) {
        const currentValue = bag.hasModelParam(pd.key)
          ? bag.getModelParam<number>(pd.key)
          : ((entry.params as Record<string, number>)[pd.key] ?? 0);
        result.push({
          elementIndex,
          key: pd.key,
          label: pd.label ?? pd.key,
          currentValue,
          unit: pd.unit ?? ANALOG_PROPERTY_UNITS[pd.key] ?? '',
          logScale: true,
        });
      }
    }

    // Regular property defs (non-model numeric properties)
    if (def.propertyDefs) {
      for (const propDef of def.propertyDefs) {
        if (propDef.type !== PropertyType.FLOAT) continue;
        const currentValue = bag.getOrDefault<number>(
          propDef.key,
          (propDef.defaultValue as number) ?? 0,
        );
        result.push({
          elementIndex,
          key: propDef.key,
          label: propDef.label,
          currentValue,
          unit: ANALOG_PROPERTY_UNITS[propDef.key] ?? '',
          logScale: true,
        });
      }
    }

    return result;
  }

  setSourceByLabel(label: string, paramKey: string, value: number): void {
    // Resolve label → CircuitElement via labelToCircuitElement when available,
    // falling back to walking allCircuitElements.
    let element: CircuitElement | undefined;
    const ltce = (this._compiled as { labelToCircuitElement?: Map<string, CircuitElement> }).labelToCircuitElement;
    if (ltce !== undefined) {
      element = ltce.get(label);
    }
    if (element === undefined) {
      element = this._compiled.allCircuitElements.find(el => {
        const props = el.getProperties();
        return props.has('label') && props.get('label') === label;
      });
    }
    if (element === undefined) return;

    // Determine resolved parameter key: use provided paramKey, falling back to
    // the primary parameter from modelRegistry.behavioral.paramDefs[0].
    let resolvedParamKey = paramKey;
    if (!resolvedParamKey && this._registry !== null) {
      const def = this._registry.get(element.typeId);
      const entry = def?.modelRegistry?.['behavioral'];
      if (entry?.paramDefs && entry.paramDefs.length > 0) {
        resolvedParamKey = entry.paramDefs[0].key;
      } else {
        resolvedParamKey = 'voltage';
      }
    }

    this.setComponentProperty(element, resolvedParamKey, value);
  }

  setComponentProperty(element: CircuitElement, key: string, value: number): void {
    // Keep the PropertyBag in sync so draw() renders the updated value
    const bag = element.getProperties();
    if (bag.hasModelParam(key)) {
      bag.setModelParam(key, value);
    }

    let handled = false;

    // --- Digital domain: update the layout property so executeFns see the change ---
    if (this._digital !== null && this._compiled.digital !== null) {
      const digIdx = this._resolveDigitalElementIndex(element);
      if (digIdx !== -1) {
        (this._compiled.digital as CompiledDigitalDomain).layout.setProperty(digIdx, key, value);
        handled = true;
      }
    }

    // --- Analog domain: route through setParam / bridge adapters ---
    if (this._analog !== null) {
      const elementIndex = this._resolveElementIndex(element);
      if (elementIndex !== -1) {
        const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;

        // Composite pin-param key (e.g. "A.rOut"): boundary adapters are now
        // full composites whose wrapper.setParam routes pin params, and other
        // composite elements route dotted keys via their own setParam, so the
        // generic element setParam fall-through below handles them uniformly.
        // No special bridge dispatch is needed here.

        const el = compiledAnalog.elements[elementIndex];
        if (el !== undefined && el.setParam) {
          el.setParam(key, value);
        }
        this._analog.configure({});
        // ngspice re-runs CKTtemp after a `.alter` so temperature/geometry-folded
        // load quantities (CAPcapac, INDinduct, …) are re-derived from the params
        // the setParam above just changed. The fold lives only in each element's
        // computeTemperature, so re-run the pass here to make a capacitance /
        // inductance / geometry / TC hot-load observable on the next solve.
        this._analog.refreshTemperatureDerivedParams();
        handled = true;
      }
    }

    if (!handled) return;
  }

  /** Resolve CircuitElement → compiled digital component index via cached inverted map. */
  private _resolveDigitalElementIndex(element: CircuitElement): number {
    if (this._digitalElementIndexCache === null) {
      this._digitalElementIndexCache = new Map();
      if (this._compiled.digital !== null) {
        for (const [idx, el] of (this._compiled.digital as CompiledDigitalDomain).componentToElement) {
          this._digitalElementIndexCache.set(el, idx);
        }
      }
    }
    return this._digitalElementIndexCache.get(element) ?? -1;
  }

  readElementCurrent(elementIndex: number): number | null {
    if (this._analog === null) return null;
    return this._analog.getElementCurrent(elementIndex);
  }

  readBranchCurrent(branchIndex: number): number | null {
    if (this._analog === null) return null;
    return this._analog.getBranchCurrent(branchIndex);
  }

  readElementPower(elementIndex: number): number | null {
    if (this._analog === null) return null;
    return this._analog.getElementPower(elementIndex);
  }

  saveSnapshot(): SnapshotId {
    if (this._digital !== null) {
      return this._digital.saveSnapshot();
    }
    return 0;
  }

  restoreSnapshot(id: SnapshotId): void {
    if (this._digital !== null) {
      this._digital.restoreSnapshot(id);
    }
  }

  /**
   * Attach a DiagnosticCollector for runtime bridge diagnostics.
   */
  setDiagnosticCollector(collector: DiagnosticCollector): void {
    this._diagnostics = collector;
  }

  /**
   * Read-only snapshot of all engine-emitted diagnostics accumulated since
   * this coordinator was constructed. Implements
   * `SimulationCoordinator.getRuntimeDiagnostics()`.
   */
  getRuntimeDiagnostics(): readonly Diagnostic[] {
    return this._diagnostics?.getDiagnostics() ?? [];
  }

  setLimitingCapture(enabled: boolean): void {
    if (this._analog === null) return;
    const mnaEngine = this._analog as MNAEngine;
    if (enabled) {
      this._limitingAccumulator = [];
      const acc = this._limitingAccumulator;
      mnaEngine.limitingCollector = [] as LimitingEvent[];
      // Register a postIterationHook that unions per-iteration events into the
      // persistent accumulator before the NR loop clears limitingCollector at
      // the top of the next iteration (niiter.c:889 ni_limit_reset analogue).
      // Only installed when applyCaptureHook has not set its own hook — the
      // capture-hook path (harness) does not use setLimitingCapture.
      if (mnaEngine.postIterationHook === null) {
        mnaEngine.postIterationHook = (
          _iteration: number,
          _rhs: Float64Array,
          _prevVoltages: Float64Array,
          _noncon: number,
          _globalConverged: boolean,
          _elemConverged: boolean,
          limitingEvents: LimitingEvent[],
        ) => {
          for (const ev of limitingEvents) acc.push(ev);
        };
      }
    } else {
      this._limitingAccumulator = null;
      mnaEngine.limitingCollector = null;
      // Remove the hook only if it is the one we installed (guard: our hook
      // does not have a drainForLog property; harness hooks do).
      const h = mnaEngine.postIterationHook as unknown as { drainForLog?: unknown } | null;
      if (h !== null && h.drainForLog === undefined) {
        mnaEngine.postIterationHook = null;
      }
    }
  }

  getLimitingEvents(): readonly LimitingEvent[] {
    return this._limitingAccumulator ?? Object.freeze([]);
  }

  /**
   * Create a DiagnosticCollector for the bridge sync logic.
   */
  private _createDiagnosticProxy(): DiagnosticCollector {
    return new DiagnosticCollector();
  }
}
