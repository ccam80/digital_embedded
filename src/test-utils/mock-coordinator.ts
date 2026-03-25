/**
 * Mock SimulationCoordinator for unit tests.
 *
 * Backed by a simple Map<SignalAddress, SignalValue> store. Tests inject
 * values via setSignal() and assert on writeSignal() calls via the
 * writeCalls record.
 */

import type { SimulationEngine, MeasurementObserver, SnapshotId } from "@/core/engine-interface";
import { EngineState } from "@/core/engine-interface";
import type { AnalogEngine, DcOpResult } from "@/core/analog-engine-interface";
import type {
  SimulationCoordinator,
  FrameStepResult,
  SliderPropertyDescriptor,
  CurrentResolverContext,
} from "@/solver/coordinator-types";
import type { Diagnostic, SignalAddress, SignalValue } from "@/compile/types";
import type { Wire } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { AcParams, AcResult } from "@/solver/analog/ac-analysis";

export type WriteCall = { addr: SignalAddress; value: SignalValue };

export class MockCoordinator implements SimulationCoordinator {
  readonly writeCalls: WriteCall[] = [];

  private _signals: Map<string, SignalValue> = new Map();
  private _digitalBackend: SimulationEngine | null = null;
  private _analogBackend: AnalogEngine | null = null;
  readonly _observers: Set<MeasurementObserver> = new Set();

  /** Inject a signal value for a given address, keyed by JSON-serialized address. */
  setSignal(addr: SignalAddress, value: SignalValue): void {
    this._signals.set(JSON.stringify(addr), value);
  }

  /** Set the digital backend (optional, for engine accessor tests). */
  setDigitalBackend(engine: SimulationEngine): void {
    this._digitalBackend = engine;
  }

  readSignal(addr: SignalAddress): SignalValue {
    const key = JSON.stringify(addr);
    return this._signals.get(key) ?? { type: "digital", value: 0 };
  }

  writeSignal(addr: SignalAddress, value: SignalValue): void {
    this.writeCalls.push({ addr, value });
  }

  readByLabel(_label: string): SignalValue {
    return { type: "digital", value: 0 };
  }

  writeByLabel(_label: string, _value: SignalValue): void {
    // no-op in mock
  }

  readAllSignals(): Map<string, SignalValue> {
    return new Map();
  }

  step(): void { /* no-op */ }
  start(): void { /* no-op */ }
  stop(): void { /* no-op */ }
  reset(): void { /* no-op */ }
  dispose(): void { /* no-op */ }

  addMeasurementObserver(observer: MeasurementObserver): void { this._observers.add(observer); }
  removeMeasurementObserver(observer: MeasurementObserver): void { this._observers.delete(observer); }

  get signalCount(): number { return 0; }
  snapshotSignals(): Float64Array { return new Float64Array(0); }

  supportsMicroStep(): boolean { return this._digitalBackend !== null; }
  supportsRunToBreak(): boolean { return this._digitalBackend !== null; }
  supportsAcSweep(): boolean { return this._analogBackend !== null; }
  supportsDcOp(): boolean { return this._analogBackend !== null; }

  microStep(): void { /* no-op */ }
  runToBreak(): void { /* no-op */ }
  dcOperatingPoint(): DcOpResult | null { return null; }
  acAnalysis(_params: AcParams): AcResult | null { return null; }

  get simTime(): number | null { return null; }
  getState(): EngineState { return EngineState.STOPPED; }

  get timingModel(): 'discrete' | 'continuous' | 'mixed' { return 'discrete'; }
  get speed(): number { return 1000; }
  set speed(_value: number) { /* no-op */ }
  adjustSpeed(_factor: number): void { /* no-op */ }
  parseSpeed(_text: string): void { /* no-op */ }
  formatSpeed(): { value: string; unit: string } { return { value: '1', unit: 'kHz' }; }
  computeFrameSteps(_wallDtSeconds: number): FrameStepResult {
    return { steps: 1, simTimeGoal: null, budgetMs: Infinity, missed: false };
  }

  advanceClocks(): void { /* no-op */ }

  getPinVoltages(_element: CircuitElement): Map<string, number> | null { return null; }
  getWireAnalogNodeId(_wire: Wire): number | undefined { return undefined; }
  get voltageRange(): { min: number; max: number } | null { return null; }
  updateVoltageTracking(): void { /* no-op */ }

  getSliderProperties(_element: CircuitElement): SliderPropertyDescriptor[] { return []; }
  setComponentProperty(_element: CircuitElement, _key: string, _value: number): void { /* no-op */ }

  readElementCurrent(_elementIndex: number): number | null { return null; }
  readBranchCurrent(_branchIndex: number): number | null { return null; }

  saveSnapshot(): SnapshotId { return 0; }
  restoreSnapshot(_id: SnapshotId): void { /* no-op */ }

  getCurrentResolverContext(): CurrentResolverContext | null { return null; }

  get digitalBackend(): SimulationEngine | null {
    return this._digitalBackend;
  }

  get analogBackend(): AnalogEngine | null {
    return this._analogBackend;
  }

  get compiled(): { wireSignalMap: ReadonlyMap<Wire, SignalAddress>; labelSignalMap: ReadonlyMap<string, SignalAddress>; diagnostics: readonly Diagnostic[] } {
    return {
      wireSignalMap: new Map(),
      labelSignalMap: new Map(),
      diagnostics: [],
    };
  }
}
