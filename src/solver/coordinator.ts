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
import type { AnalogEngine, DcOpResult } from '../core/analog-engine-interface.js';
import { DigitalEngine } from './digital/digital-engine.js';
import type { ConcreteCompiledCircuit } from './digital/digital-engine.js';
import { ClockManager } from './digital/clock.js';
import type { CompiledCircuitImpl as CompiledDigitalDomain } from './digital/compiled-circuit.js';
import { MNAEngine } from './analog/analog-engine.js';
import { BitVector } from '../core/signal.js';
import { FacadeError } from '../headless/types.js';
import { DiagnosticCollector } from './analog/diagnostics.js';
import type { SimulationCoordinator, FrameStepResult, CurrentResolverContext, SliderPropertyDescriptor } from './coordinator-types.js';
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
import type { BridgeOutputAdapter, BridgeInputAdapter } from './analog/bridge-adapter.js';
import { SpeedControl } from '../integration/speed-control.js';
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
 * Tracks previous bit for hysteresis in the indeterminate voltage band.
 */
interface TopLevelBridgeState {
  prevBit: number;
}

export class DefaultSimulationCoordinator implements SimulationCoordinator {
  private readonly _compiled: CompiledCircuitUnified;
  private readonly _digital: SimulationEngine | null;
  private readonly _analog: AnalogEngine | null;
  private readonly _bridges: BridgeAdapter[];
  private readonly _topLevelBridgeStates: TopLevelBridgeState[];
  /** Resolved MNA bridge adapters parallel to _bridges. Index i → adapters for _bridges[i]. */
  private readonly _resolvedBridgeAdapters: Array<Array<BridgeOutputAdapter | BridgeInputAdapter>>;
  private readonly _clockManager: ClockManager | null;
  private _diagnostics: DiagnosticCollector | null = null;
  private readonly _observers: Set<MeasurementObserver> = new Set();
  private _stepCount = 0;
  private readonly _timingModel: 'discrete' | 'continuous' | 'mixed';
  private readonly _speedControl: SpeedControl;
  /** Analog speed in sim-s/wall-s. Used when timingModel is continuous or mixed. */
  private _analogSpeed: number = 1e-3;
  private _voltageMin: number = Infinity;
  private _voltageMax: number = -Infinity;
  private readonly _registry: ComponentRegistry | null;
  private _cachedDcOpResult: DcOpResult | null = null;
  /** Lazily-built inverted index: CircuitElement → analog element index. */
  private _elementIndexCache: Map<CircuitElement, number> | null = null;
  /** Lazily-built inverted index: CircuitElement → digital component index. */
  private _digitalElementIndexCache: Map<CircuitElement, number> | null = null;
  /** Reusable Map for getPinVoltages() to avoid per-call allocation. */
  private readonly _pinVoltageResult = new Map<string, number>();

  constructor(compiled: CompiledCircuitUnified, registry?: ComponentRegistry) {
    this._registry = registry ?? null;
    this._compiled = compiled;
    this._bridges = compiled.bridges;
    this._topLevelBridgeStates = compiled.bridges.map(() => ({ prevBit: 0 }));

    // Resolve MNA bridge adapters from the compiled analog circuit.
    // Each BridgeAdapter descriptor maps to the adapters registered under its
    // boundaryGroupId in bridgeAdaptersByGroupId.
    if (compiled.analog !== null) {
      const compiledAnalog = compiled.analog as ConcreteCompiledAnalogCircuit;
      this._resolvedBridgeAdapters = compiled.bridges.map(bridge =>
        compiledAnalog.bridgeAdaptersByGroupId.get(bridge.boundaryGroupId) ?? [],
      );
    } else {
      this._resolvedBridgeAdapters = compiled.bridges.map(() => []);
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
      this._cachedDcOpResult = engine.dcOperatingPoint();
      this._analog = engine;

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

    this._speedControl = new SpeedControl();

    if (this._analog !== null) {
      const mnaEngine = this._analog as MNAEngine;
      if (typeof mnaEngine.onDiagnostic === 'function') {
        this._diagnostics = this._createDiagnosticProxy();
      }
    }
  }

  get compiled(): CompiledCircuitUnified { return this._compiled; }

  /**
   * Returns the internal digital engine for use by solver-internal code only.
   * Consumers must not call this — use capability queries and coordinator methods.
   */
  getDigitalEngine(): SimulationEngine | null { return this._digital; }

  /**
   * Returns the internal analog engine for use by solver-internal code only.
   * Consumers must not call this — use readSignal, readElementCurrent, etc.
   */
  getAnalogEngine(): AnalogEngine | null { return this._analog; }

  start(): void { this._digital?.start(); this._analog?.start(); }
  stop(): void { this._digital?.stop(); this._analog?.stop(); }

  reset(): void {
    this._digital?.reset();
    this._analog?.reset();
    for (const state of this._topLevelBridgeStates) {
      state.prevBit = 0;
    }
    this._stepCount = 0;
    this._voltageMin = Infinity;
    this._voltageMax = -Infinity;
    for (const obs of this._observers) obs.onReset();
  }

  dispose(): void {
    this._digital?.dispose();
    this._analog?.dispose();
    this._observers.clear();
  }

  step(): void {
    if (this._digital !== null && this._analog !== null) {
      this._stepMixed();
    } else if (this._digital !== null) {
      this._digital.step();
    } else if (this._analog !== null) {
      this._analog.step();
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

    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.direction !== 'analog-to-digital') continue;
      const voltage = analog.getNodeVoltage(bridge.analogNodeId);
      const adapters = this._resolvedBridgeAdapters[i]!;
      let bit: number;
      const inputAdapter = adapters.find(
        (a): a is BridgeInputAdapter => 'readLogicLevel' in a,
      );
      if (inputAdapter === undefined) {
        this._diagnostics?.emit({
          code: 'bridge-missing-inner-pin',
          severity: 'error',
          summary: `No BridgeInputAdapter for boundary group ${bridge.boundaryGroupId}`,
          explanation: 'An analog-to-digital bridge has no registered BridgeInputAdapter. This indicates a compilation error — the bridge was not fully assembled.',
          suggestions: [],
        });
        continue;
      }
      const level = inputAdapter.readLogicLevel(voltage);
      if (level === true) {
        bit = 1;
        this._topLevelBridgeStates[i]!.prevBit = 1;
      } else if (level === false) {
        bit = 0;
        this._topLevelBridgeStates[i]!.prevBit = 0;
      } else {
        bit = this._topLevelBridgeStates[i]!.prevBit;
      }
      digital.setSignalValue(bridge.digitalNetId, BitVector.fromNumber(bit, bridge.bitWidth));
    }

    digital.step();

    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.direction !== 'digital-to-analog') continue;
      const raw = digital.getSignalRaw(bridge.digitalNetId);
      const high = raw !== 0;
      const adapters = this._resolvedBridgeAdapters[i]!;
      const outputAdapter = adapters.find(
        (a): a is BridgeOutputAdapter => 'setLogicLevel' in a,
      );
      if (outputAdapter !== undefined) {
        outputAdapter.setLogicLevel(high);
      }
      if (high) {
        analog.addBreakpoint(analog.simTime);
      }
    }

    analog.step();
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
    throw new FacadeError('Setting analog node voltages via writeSignal is not yet supported');
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

  microStep(): void {
    if (this._digital !== null) this._digital.microStep();
  }

  runToBreak(): void {
    if (this._digital !== null) this._digital.runToBreak();
  }

  dcOperatingPoint(): DcOpResult | null {
    return this._cachedDcOpResult;
  }

  acAnalysis(params: AcParams): AcResult | null {
    if (this._analog === null) return null;
    return this._analog.acAnalysis(params);
  }

  async stepToTime(targetSimTime: number, budgetMs = 5000): Promise<number> {
    if (this._analog === null) return 0;
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

  get simTime(): number | null {
    return this._analog !== null ? this._analog.simTime : null;
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
    return this._timingModel === 'discrete'
      ? this._speedControl.speed
      : this._analogSpeed;
  }

  set speed(value: number) {
    if (this._timingModel === 'discrete') {
      this._speedControl.speed = value;
    } else {
      this._analogSpeed = Math.max(1e-9, value);
    }
  }

  adjustSpeed(factor: number): void {
    if (this._timingModel === 'discrete') {
      this._speedControl.speed = this._speedControl.speed * factor;
    } else {
      this._analogSpeed = Math.max(1e-9, this._analogSpeed * factor);
    }
  }

  parseSpeed(text: string): void {
    if (this._timingModel === 'discrete') {
      this._speedControl.parseText(text);
    } else {
      const parsed = Number(text);
      if (Number.isFinite(parsed) && parsed > 0) {
        this._analogSpeed = parsed;
      }
    }
  }

  formatSpeed(): { value: string; unit: string } {
    if (this._timingModel === 'discrete') {
      const s = this._speedControl.speed;
      if (s >= 1_000_000) return { value: String(s / 1_000_000), unit: 'MHz' };
      if (s >= 1_000) return { value: String(s / 1_000), unit: 'kHz' };
      return { value: String(s), unit: 'Hz' };
    }
    const rate = this._analogSpeed;
    if (rate >= 1) return { value: String(rate), unit: 's/s' };
    if (rate >= 1e-3) return { value: String(rate * 1_000), unit: 'ms/s' };
    if (rate >= 1e-6) return { value: String(rate * 1_000_000), unit: 'µs/s' };
    return { value: String(rate * 1e9), unit: 'ns/s' };
  }

  computeFrameSteps(wallDtSeconds: number): FrameStepResult {
    const clampedDt = Math.min(wallDtSeconds, 0.1);
    if (this._timingModel === 'discrete') {
      return {
        steps: Math.max(1, Math.round(this._speedControl.speed * clampedDt)),
        simTimeGoal: null,
        budgetMs: Infinity,
        missed: false,
      };
    }
    const simTime = this._analog!.simTime;
    return {
      steps: 0,
      simTimeGoal: simTime + this._analogSpeed * clampedDt,
      budgetMs: 12,
      missed: false,
    };
  }

  advanceClocks(): void {
    if (this._clockManager === null || this._digital === null) return;
    this._clockManager.advanceClocks((this._digital as DigitalEngine).getSignalArray());
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
    const def = this._registry.get(element.typeId);
    if (!def) return [];
    const bag = element.getProperties();
    const result: SliderPropertyDescriptor[] = [];

    // Model params (primary source of tunable analog parameters)
    const modelKey = bag.has("model") ? bag.get<string>("model") : (def.defaultModel ?? "behavioral");
    const entry = def.modelRegistry?.[modelKey];
    if (entry?.paramDefs) {
      for (const pd of entry.paramDefs) {
        const currentValue = bag.hasModelParam(pd.key)
          ? bag.getModelParam<number>(pd.key)
          : ((entry.params as Record<string, number>)[pd.key] ?? 0);
        result.push({
          elementIndex,
          key: pd.key,
          label: pd.label,
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

        // Composite pin-param key (e.g. "A.rOut") → route to bridge adapters via
        // bridgeAdaptersByGroupId. We find adapters whose label ends with the pin
        // label suffix so that "A.rOut" routes to the adapter for pin "A".
        const dotIdx = key.indexOf('.');
        if (dotIdx !== -1) {
          const pinLabel = key.slice(0, dotIdx);
          const paramName = key.slice(dotIdx + 1);
          let bridgeHandled = false;
          for (const adapters of compiledAnalog.bridgeAdaptersByGroupId.values()) {
            for (const adapter of adapters) {
              if (adapter.label?.endsWith(`:${pinLabel}`)) {
                adapter.setParam(paramName, value);
                bridgeHandled = true;
              }
            }
          }
          if (!bridgeHandled) {
            // No bridge adapter matched — the element may hold pin models
            // internally (e.g. behavioral analog models). Forward the full
            // composite key so the element can route it via delegatePinSetParam.
            const el = compiledAnalog.elements[elementIndex];
            if (el !== undefined && el.setParam) {
              el.setParam(key, value);
            }
          }
          this._analog.configure({});
          handled = true;
        }

        const el = compiledAnalog.elements[elementIndex];
        if (el !== undefined && el.setParam) {
          el.setParam(key, value);
        }
        this._analog.configure({});
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
   * Create a DiagnosticCollector for the bridge sync logic.
   */
  private _createDiagnosticProxy(): DiagnosticCollector {
    return new DiagnosticCollector();
  }
}
