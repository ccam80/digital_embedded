/**
 * DefaultSimulationCoordinator -- unified coordinator for all circuit types.
 *
 * Wraps digital and analog backends with bridge synchronisation between
 * domains. Provides a single stepping interface regardless of which backends
 * are active, and notifies registered MeasurementObservers after each step.
 *
 * Bridge sync uses BridgeInstance runtime adapters from the compiled analog
 * circuit. Each BridgeInstance holds BridgeInputAdapter/BridgeOutputAdapter
 * objects that stamp Norton equivalents into the MNA matrix. The coordinator
 * creates a DigitalEngine per bridge instance, reads analog voltages via
 * adapter.readLogicLevel(), and drives output adapters via
 * adapter.setLogicLevel().
 *
 * Spec: unified-component-architecture.md Section 5 (Phase 4, P4-2/P4-6).
 */

import type { SimulationEngine, MeasurementObserver, SnapshotId } from '../core/engine-interface.js';
import { EngineState } from '../core/engine-interface.js';
import type { AnalogEngine, DcOpResult } from '../core/analog-engine-interface.js';
import { DigitalEngine } from './digital/digital-engine.js';
import type { ConcreteCompiledCircuit } from './digital/digital-engine.js';
import { ClockManager } from './digital/clock.js';
import { MNAEngine } from './analog/analog-engine.js';
import { BitVector } from '../core/signal.js';
import { FacadeError } from '../headless/types.js';
import { readMnaVoltage } from './analog/digital-pin-model.js';
import { makeDiagnostic, DiagnosticCollector } from './analog/diagnostics.js';
import type { BridgeInstance } from './analog/bridge-instance.js';
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
import { SpeedControl } from '../integration/speed-control.js';
import type { ComponentRegistry } from '../core/registry.js';
import { PropertyType } from '../core/properties.js';

/** Elements that support live parameter mutation via setParam(key, value). */
interface ParameterMutableElement {
  setParam(key: string, value: number): void;
}

function isParameterMutable(el: unknown): el is ParameterMutableElement {
  return typeof (el as ParameterMutableElement).setParam === 'function';
}

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

/** Per-bridge runtime state for bridge sync between analog and digital domains. */
interface BridgeState {
  innerEngine: DigitalEngine;
  prevInputBits: boolean[];
  prevOutputBits: boolean[];
  prevInputVoltages: number[];
  indeterminateCount: number[];
  oscillatingCount: number[];
}

export class DefaultSimulationCoordinator implements SimulationCoordinator {
  private readonly _compiled: CompiledCircuitUnified;
  private readonly _digital: SimulationEngine | null;
  private readonly _analog: AnalogEngine | null;
  private readonly _bridges: BridgeAdapter[];
  private readonly _topLevelBridgeStates: TopLevelBridgeState[];
  private readonly _bridgeInstances: BridgeInstance[];
  private readonly _bridgeStates: BridgeState[];
  private readonly _clockManager: ClockManager | null;
  private _diagnostics: DiagnosticCollector | null = null;
  private readonly _observers: Set<MeasurementObserver> = new Set();
  private _stepCount = 0;
  private _voltageBuffer: Float64Array | null = null;
  private readonly _timingModel: 'discrete' | 'continuous' | 'mixed';
  private readonly _speedControl: SpeedControl;
  /** Analog speed in sim-s/wall-s. Used when timingModel is continuous or mixed. */
  private _analogSpeed: number = 1e-3;
  private _voltageMin: number = Infinity;
  private _voltageMax: number = -Infinity;
  private readonly _registry: ComponentRegistry | null;

  constructor(compiled: CompiledCircuitUnified, registry?: ComponentRegistry) {
    this._registry = registry ?? null;
    this._compiled = compiled;
    this._bridges = compiled.bridges;
    this._topLevelBridgeStates = compiled.bridges.map(() => ({ prevBit: 0 }));

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
      engine.dcOperatingPoint();
      this._analog = engine;

      const compiledAnalog = compiled.analog as ConcreteCompiledAnalogCircuit;
      this._bridgeInstances = compiledAnalog.bridges ?? [];
      this._voltageBuffer = new Float64Array(compiledAnalog.matrixSize);
    } else {
      this._analog = null;
      this._bridgeInstances = [];
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

    this._bridgeStates = this._bridgeInstances.map((bridge) => {
      const innerEngine = new DigitalEngine('level');
      innerEngine.init(bridge.compiledInner);
      return {
        innerEngine,
        prevInputBits: bridge.inputAdapters.map(() => false),
        prevOutputBits: bridge.outputAdapters.map(() => false),
        prevInputVoltages: bridge.inputAdapters.map(() => 0),
        indeterminateCount: bridge.inputAdapters.map(() => 0),
        oscillatingCount: bridge.inputAdapters.map(() => 0),
      };
    });

    if (this._analog !== null) {
      const mnaEngine = this._analog as MNAEngine;
      if (typeof mnaEngine.onDiagnostic === 'function') {
        this._diagnostics = this._createDiagnosticProxy();
      }
    }
  }

  get digitalBackend(): SimulationEngine | null { return this._digital; }
  get analogBackend(): AnalogEngine | null { return this._analog; }
  get compiled(): CompiledCircuitUnified { return this._compiled; }

  start(): void { this._digital?.start(); this._analog?.start(); }
  stop(): void { this._digital?.stop(); this._analog?.stop(); }

  reset(): void {
    this._digital?.reset();
    this._analog?.reset();
    for (const state of this._topLevelBridgeStates) {
      state.prevBit = 0;
    }
    for (const state of this._bridgeStates) {
      state.innerEngine.reset();
      state.prevInputBits.fill(false);
      state.prevOutputBits.fill(false);
      state.prevInputVoltages.fill(0);
      state.indeterminateCount.fill(0);
      state.oscillatingCount.fill(0);
    }
    this._stepCount = 0;
    this._voltageMin = Infinity;
    this._voltageMax = -Infinity;
    for (const obs of this._observers) obs.onReset();
  }

  dispose(): void {
    this._digital?.dispose();
    this._analog?.dispose();
    for (const state of this._bridgeStates) {
      state.innerEngine.dispose();
    }
    this._observers.clear();
  }

  step(): void {
    if (this._digital !== null && this._analog !== null) {
      this._stepMixed();
    } else if (this._digital !== null) {
      this._digital.step();
    } else if (this._analog !== null) {
      this._stepAnalogWithBridges();
    }
    this._stepCount++;
    for (const obs of this._observers) obs.onStep(this._stepCount);
  }

  /**
   * Mixed-signal step: both digital and analog backends are active.
   * Uses BridgeAdapter descriptors (compiled.bridges) for the top-level
   * digital↔analog net/node mapping, and BridgeInstance runtime adapters
   * for cross-engine subcircuit boundaries.
   */
  private _stepMixed(): void {
    const digital = this._digital!;
    const analog = this._analog!;

    if (this._bridges.length === 0 && this._bridgeInstances.length === 0) {
      digital.step();
      analog.step();
      return;
    }

    for (let i = 0; i < this._bridges.length; i++) {
      const bridge = this._bridges[i]!;
      if (bridge.direction !== 'analog-to-digital') continue;
      const voltage = analog.getNodeVoltage(bridge.analogNodeId);
      const bit = this._thresholdVoltage(voltage, bridge, i);
      digital.setSignalValue(bridge.digitalNetId, BitVector.fromNumber(bit, bridge.bitWidth));
    }

    digital.step();

    for (const bridge of this._bridges) {
      if (bridge.direction !== 'digital-to-analog') continue;
      const raw = digital.getSignalRaw(bridge.digitalNetId);
      const high = raw !== 0;
      this._stampDigitalToAnalog(bridge, high);
    }

    if (this._bridgeInstances.length > 0) {
      this._syncBeforeAnalogStep();
    }

    analog.step();

    if (this._bridgeInstances.length > 0) {
      this._syncAfterAnalogStep();
    }
  }

  /**
   * Analog-only step with bridge instances (cross-engine subcircuits).
   * Uses BridgeInstance runtime adapters for full bridge sync including
   * Norton equivalent stamping, threshold detection, and diagnostics.
   */
  private _stepAnalogWithBridges(): void {
    const analog = this._analog!;

    if (this._bridgeInstances.length > 0) {
      this._syncBeforeAnalogStep();
    }

    analog.step();

    if (this._bridgeInstances.length > 0) {
      this._syncAfterAnalogStep();
    }
  }

  /**
   * Pre-step bridge sync: read analog voltages at bridge input adapters,
   * threshold-detect to digital bits, step inner digital engines, read
   * digital outputs and drive bridge output adapters.
   */
  private _syncBeforeAnalogStep(): void {
    const analog = this._analog!;
    const voltages = this._getAnalogVoltages();

    for (let b = 0; b < this._bridgeInstances.length; b++) {
      const bridge = this._bridgeInstances[b]!;
      const state = this._bridgeStates[b]!;

      for (let i = 0; i < bridge.inputAdapters.length; i++) {
        const adapter = bridge.inputAdapters[i]!;
        const netId = bridge.inputPinNetIds[i]!;
        const nodeId = adapter.inputNodeId;
        const voltage = readMnaVoltage(nodeId, voltages);
        const level = adapter.readLogicLevel(voltage);

        if (level === undefined) {
          state.indeterminateCount[i] = (state.indeterminateCount[i] ?? 0) + 1;
          if (state.indeterminateCount[i] === 10 && this._diagnostics !== null) {
            this._diagnostics.emit(
              makeDiagnostic(
                'bridge-indeterminate-input',
                'warning',
                `Bridge input pin "${adapter.label ?? String(i)}" voltage ${voltage.toFixed(3)}V is in the indeterminate band for 10+ consecutive timesteps`,
                {
                  explanation:
                    `The analog voltage at bridge input "${adapter.label ?? String(i)}" ` +
                    `(${voltage.toFixed(3)}V) has been between V_IL and V_IH for more than ` +
                    `10 consecutive timesteps. The digital interpretation is ambiguous. ` +
                    `Ensure the analog driver can fully swing to a valid logic level.`,
                },
              ),
            );
          }
        } else {
          state.indeterminateCount[i] = 0;
        }

        const bit = level !== undefined ? level : state.prevInputBits[i] ?? false;
        state.prevInputBits[i] = bit;

        state.innerEngine.setSignalValue(netId, BitVector.fromNumber(bit ? 1 : 0, 1));
      }

      state.innerEngine.step();

      let anyOutputChanged = false;
      for (let o = 0; o < bridge.outputAdapters.length; o++) {
        const adapter = bridge.outputAdapters[o]!;
        const netId = bridge.outputPinNetIds[o]!;

        const rawValue = state.innerEngine.getSignalRaw(netId);
        const signalValue = state.innerEngine.getSignalValue(netId);

        const isHiZ = signalValue.isHighZ && !signalValue.isUndefined;
        if (isHiZ) {
          adapter.setHighZ(true);
        } else {
          adapter.setHighZ(false);
          const high = rawValue !== 0;
          adapter.setLogicLevel(high);

          const prevHigh = state.prevOutputBits[o] ?? false;
          if (high !== prevHigh) {
            anyOutputChanged = true;
          }
          state.prevOutputBits[o] = high;
        }
      }

      if (anyOutputChanged) {
        analog.addBreakpoint(analog.simTime);
      }
    }
  }

  /**
   * Post-step bridge sync: check for threshold crossings on analog input
   * nodes and re-evaluate inner digital engines when crossings are detected.
   */
  private _syncAfterAnalogStep(): void {
    const voltages = this._getAnalogVoltages();

    for (let b = 0; b < this._bridgeInstances.length; b++) {
      const bridge = this._bridgeInstances[b]!;
      const state = this._bridgeStates[b]!;

      let crossingDetected = false;

      for (let i = 0; i < bridge.inputAdapters.length; i++) {
        const adapter = bridge.inputAdapters[i]!;
        const nodeId = adapter.inputNodeId;
        const prevVoltage = state.prevInputVoltages[i] ?? 0;
        const currVoltage = readMnaVoltage(nodeId, voltages);

        const prevLevel = adapter.readLogicLevel(prevVoltage);
        const currLevel = adapter.readLogicLevel(currVoltage);

        if (prevLevel !== currLevel) {
          crossingDetected = true;
          state.oscillatingCount[i] = (state.oscillatingCount[i] ?? 0) + 1;
          if (state.oscillatingCount[i] === 20 && this._diagnostics !== null) {
            this._diagnostics.emit(
              makeDiagnostic(
                'bridge-oscillating-input',
                'warning',
                `Bridge input pin "${adapter.label ?? String(i)}" is oscillating across a threshold for 20+ consecutive timesteps`,
                {
                  explanation:
                    `The analog voltage at bridge input "${adapter.label ?? String(i)}" ` +
                    `has crossed a logic threshold on every timestep for 20 consecutive steps. ` +
                    `This may indicate an oscillating signal or simulation instability near a threshold. ` +
                    `Consider adding hysteresis or a Schmitt trigger at the boundary.`,
                },
              ),
            );
          }
        } else {
          state.oscillatingCount[i] = 0;
        }

        state.prevInputVoltages[i] = currVoltage;
      }

      if (crossingDetected) {
        for (let i = 0; i < bridge.inputAdapters.length; i++) {
          const adapter = bridge.inputAdapters[i]!;
          const netId = bridge.inputPinNetIds[i]!;
          const nodeId = adapter.inputNodeId;
          const voltage = readMnaVoltage(nodeId, voltages);
          const level = adapter.readLogicLevel(voltage);
          const bit = level !== undefined ? level : state.prevInputBits[i] ?? false;
          state.prevInputBits[i] = bit;
          state.innerEngine.setSignalValue(netId, BitVector.fromNumber(bit ? 1 : 0, 1));
        }

        state.innerEngine.step();

        for (let o = 0; o < bridge.outputAdapters.length; o++) {
          const adapter = bridge.outputAdapters[o]!;
          const netId = bridge.outputPinNetIds[o]!;

          const rawValue = state.innerEngine.getSignalRaw(netId);
          const signalValue = state.innerEngine.getSignalValue(netId);
          const isHiZ = signalValue.isHighZ && !signalValue.isUndefined;

          if (isHiZ) {
            adapter.setHighZ(true);
          } else {
            adapter.setHighZ(false);
            const high = rawValue !== 0;
            adapter.setLogicLevel(high);
            state.prevOutputBits[o] = high;
          }
        }
      }
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
    if (this._analog === null) return null;
    return this._analog.dcOperatingPoint();
  }

  acAnalysis(params: AcParams): AcResult | null {
    if (this._analog === null) return null;
    return this._analog.acAnalysis(params);
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
      this._analogSpeed = Math.max(0, value);
    }
  }

  adjustSpeed(factor: number): void {
    if (this._timingModel === 'discrete') {
      this._speedControl.speed = this._speedControl.speed * factor;
    } else {
      this._analogSpeed = Math.max(0, this._analogSpeed * factor);
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
        steps: Math.round(this._speedControl.speed * clampedDt),
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

  getPinVoltages(element: CircuitElement): Map<string, number> | null {
    if (this._analog === null) return null;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    let elementIndex = -1;
    for (const [idx, el] of compiledAnalog.elementToCircuitElement) {
      if (el === element) {
        elementIndex = idx;
        break;
      }
    }
    if (elementIndex === -1) return null;
    const resolvedPins = compiledAnalog.elementResolvedPins.get(elementIndex);
    if (resolvedPins === undefined || resolvedPins.length === 0) return null;
    const result = new Map<string, number>();
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
      getElementPinCurrents(elementIndex: number): number[] {
        return analog.getElementPinCurrents(elementIndex);
      },
    };
  }

  getSliderProperties(element: CircuitElement): SliderPropertyDescriptor[] {
    if (this._analog === null || this._registry === null) return [];
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    let elementIndex = -1;
    for (const [idx, ce] of compiledAnalog.elementToCircuitElement) {
      if (ce === element) { elementIndex = idx; break; }
    }
    if (elementIndex === -1) return [];
    const def = this._registry.get(element.typeId);
    if (!def?.propertyDefs) return [];
    const result: SliderPropertyDescriptor[] = [];
    for (const propDef of def.propertyDefs) {
      if (propDef.type !== PropertyType.FLOAT) continue;
      const currentValue = element.getProperties().getOrDefault<number>(
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
    return result;
  }

  setComponentProperty(element: CircuitElement, key: string, value: number): void {
    if (this._analog === null) return;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    let elementIndex = -1;
    for (const [idx, ce] of compiledAnalog.elementToCircuitElement) {
      if (ce === element) { elementIndex = idx; break; }
    }
    if (elementIndex === -1) return;
    const el = compiledAnalog.elements[elementIndex];
    if (el === undefined) return;
    if (isParameterMutable(el)) {
      el.setParam(key, value);
    }
    this._analog.configure({});
  }

  readElementCurrent(elementIndex: number): number | null {
    if (this._analog === null) return null;
    return this._analog.getElementCurrent(elementIndex);
  }

  readBranchCurrent(branchIndex: number): number | null {
    if (this._analog === null) return null;
    return this._analog.getBranchCurrent(branchIndex);
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

  private _thresholdVoltage(voltage: number, bridge: BridgeAdapter, bridgeIndex: number): number {
    const spec = bridge.electricalSpec;
    const vIH = spec.vIH ?? 2.0;
    const vIL = spec.vIL ?? 0.8;
    const state = this._topLevelBridgeStates[bridgeIndex]!;
    if (voltage >= vIH) {
      state.prevBit = 1;
      return 1;
    }
    if (voltage <= vIL) {
      state.prevBit = 0;
      return 0;
    }
    // Indeterminate band: hold previous value (hysteresis)
    return state.prevBit;
  }

  /**
   * Drive a digital-to-analog bridge: find the matching BridgeInstance output
   * adapter and set its logic level. Falls back to breakpoint registration
   * when no matching runtime adapter exists.
   */
  private _stampDigitalToAnalog(bridge: BridgeAdapter, high: boolean): void {
    for (const inst of this._bridgeInstances) {
      for (const adapter of inst.outputAdapters) {
        if (adapter.outputNodeId === bridge.analogNodeId) {
          adapter.setLogicLevel(high);
          return;
        }
      }
    }
    if (high) {
      this._analog!.addBreakpoint(this._analog!.simTime);
    }
  }

  /**
   * Get the MNA voltage vector from the analog engine.
   * Uses the engine's getNodeVoltage for each node to build the array.
   */
  private _getAnalogVoltages(): Float64Array {
    const analog = this._analog!;
    const compiledAnalog = this._compiled.analog as ConcreteCompiledAnalogCircuit;
    const voltages = this._voltageBuffer!;
    voltages.fill(0);
    for (let i = 0; i < compiledAnalog.nodeCount; i++) {
      voltages[i] = analog.getNodeVoltage(i + 1);
    }
    return voltages;
  }

  /**
   * Create a DiagnosticCollector for the bridge sync logic.
   */
  private _createDiagnosticProxy(): DiagnosticCollector {
    return new DiagnosticCollector();
  }
}
