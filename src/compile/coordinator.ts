/**
 * DefaultSimulationCoordinator -- unified coordinator for all circuit types.
 *
 * Wraps digital and analog backends with bridge synchronisation between
 * domains. Provides a single stepping interface regardless of which backends
 * are active, and notifies registered MeasurementObservers after each step.
 *
 * Spec: unified-component-architecture.md Section 5 (Phase 4, P4-2).
 */

import type { SimulationEngine, MeasurementObserver } from '../core/engine-interface.js';
import type { AnalogEngine } from '../core/analog-engine-interface.js';
import { DigitalEngine } from '../engine/digital-engine.js';
import { MNAEngine } from '../analog/analog-engine.js';
import { BitVector } from '../core/signal.js';
import { FacadeError } from '../headless/types.js';
import type { SimulationCoordinator } from './coordinator-types.js';
import type {
  CompiledCircuitUnified,
  BridgeAdapter,
  SignalAddress,
  SignalValue,
} from './types.js';

export class DefaultSimulationCoordinator implements SimulationCoordinator {
  private readonly _compiled: CompiledCircuitUnified;
  private readonly _digital: SimulationEngine | null;
  private readonly _analog: AnalogEngine | null;
  private readonly _bridges: BridgeAdapter[];
  private readonly _observers: Set<MeasurementObserver> = new Set();
  private _stepCount = 0;

  constructor(compiled: CompiledCircuitUnified) {
    this._compiled = compiled;
    this._bridges = compiled.bridges;

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
    } else {
      this._analog = null;
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
    this._stepCount = 0;
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

  private _stepMixed(): void {
    const digital = this._digital!;
    const analog = this._analog!;

    if (this._bridges.length === 0) {
      digital.step();
      analog.step();
      return;
    }

    for (const bridge of this._bridges) {
      if (bridge.direction !== 'analog-to-digital') continue;
      const voltage = analog.getNodeVoltage(bridge.analogNodeId);
      const bit = this._thresholdVoltage(voltage, bridge);
      digital.setSignalValue(bridge.digitalNetId, BitVector.fromNumber(bit, bridge.bitWidth));
    }

    digital.step();

    for (const bridge of this._bridges) {
      if (bridge.direction !== 'digital-to-analog') continue;
      const raw = digital.getSignalRaw(bridge.digitalNetId);
      const voltage = this._digitalToVoltage(raw !== 0, bridge);
      analog.addBreakpoint(analog.simTime);
      void voltage;
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

  private _thresholdVoltage(voltage: number, bridge: BridgeAdapter): number {
    const spec = bridge.electricalSpec;
    const vIH = spec.vIH ?? 2.0;
    const vIL = spec.vIL ?? 0.8;
    if (voltage >= vIH) return 1;
    if (voltage <= vIL) return 0;
    return 0;
  }

  private _digitalToVoltage(high: boolean, bridge: BridgeAdapter): number {
    const spec = bridge.electricalSpec;
    return high ? (spec.vOH ?? 3.3) : (spec.vOL ?? 0.0);
  }
}
