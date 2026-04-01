/**
 * NullSimulationCoordinator — a no-op implementation of SimulationCoordinator.
 *
 * Used as the initial value of DefaultSimulatorFacade._coordinator so that
 * all consumers can call coordinator methods without null-checking. Signal
 * read/write methods throw FacadeError("No circuit compiled") to surface
 * misconfiguration clearly. All other methods are safe no-ops or return
 * neutral values.
 */

import type {
  SimulationCoordinator,
  FrameStepResult,
  CurrentResolverContext,
  SliderPropertyDescriptor,
} from './coordinator-types.js';
import { EngineState } from '../core/engine-interface.js';
import type { MeasurementObserver, SnapshotId } from '../core/engine-interface.js';
import { FacadeError } from '../headless/types.js';
import type { DcOpResult } from '../core/analog-engine-interface.js';
import type { SignalAddress, SignalValue } from '../compile/types.js';
import type { AcParams, AcResult } from './analog/ac-analysis.js';
import type { Wire } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';

export class NullSimulationCoordinator implements SimulationCoordinator {
  // -------------------------------------------------------------------------
  // Lifecycle — no-ops
  // -------------------------------------------------------------------------

  step(): void { /* no circuit compiled */ }
  start(): void { /* no circuit compiled */ }
  stop(): void { /* no circuit compiled */ }
  reset(): void { /* no circuit compiled */ }
  dispose(): void { /* no circuit compiled */ }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  getState(): EngineState { return EngineState.STOPPED; }

  // -------------------------------------------------------------------------
  // Signal I/O — throw to surface misconfiguration
  // -------------------------------------------------------------------------

  readSignal(_addr: SignalAddress): SignalValue {
    throw new FacadeError('No circuit compiled');
  }

  writeSignal(_addr: SignalAddress, _value: SignalValue): void {
    throw new FacadeError('No circuit compiled');
  }

  readByLabel(_label: string): SignalValue {
    throw new FacadeError('No circuit compiled');
  }

  writeByLabel(_label: string, _value: SignalValue): void {
    throw new FacadeError('No circuit compiled');
  }

  readAllSignals(): Map<string, SignalValue> {
    return new Map();
  }

  // -------------------------------------------------------------------------
  // Compiled output — empty maps, no engines
  // -------------------------------------------------------------------------

  readonly compiled = {
    wireSignalMap: new Map<Wire, SignalAddress>(),
    labelSignalMap: new Map<string, SignalAddress>(),
    diagnostics: [] as import('../compile/types.js').Diagnostic[],
    digital: null,
    analog: null,
  };

  // -------------------------------------------------------------------------
  // Observers — no-ops
  // -------------------------------------------------------------------------

  addMeasurementObserver(_observer: MeasurementObserver): void { /* no-op */ }
  removeMeasurementObserver(_observer: MeasurementObserver): void { /* no-op */ }

  // -------------------------------------------------------------------------
  // Capability queries — all false
  // -------------------------------------------------------------------------

  supportsMicroStep(): boolean { return false; }
  supportsRunToBreak(): boolean { return false; }
  supportsAcSweep(): boolean { return false; }
  supportsDcOp(): boolean { return false; }

  // -------------------------------------------------------------------------
  // Feature execution — no-ops / null
  // -------------------------------------------------------------------------

  microStep(): void { /* no-op */ }
  runToBreak(): void { /* no-op */ }
  dcOperatingPoint(): DcOpResult | null { return null; }
  acAnalysis(_params: AcParams): AcResult | null { return null; }
  async stepToTime(_targetSimTime: number, _budgetMs?: number): Promise<number> { return 0; }

  // -------------------------------------------------------------------------
  // Timing
  // -------------------------------------------------------------------------

  readonly simTime: number | null = null;
  readonly timingModel: 'discrete' | 'continuous' | 'mixed' = 'continuous';

  snapshotSignals(): Float64Array { return new Float64Array(0); }
  readonly signalCount: number = 0;

  computeFrameSteps(_wallDtSeconds: number): FrameStepResult {
    return { steps: 0, simTimeGoal: null, budgetMs: 12, missed: false };
  }

  // -------------------------------------------------------------------------
  // Speed — neutral defaults
  // -------------------------------------------------------------------------

  speed: number = 1e-3;

  adjustSpeed(_factor: number): void { /* no-op */ }
  parseSpeed(_text: string): void { /* no-op */ }
  formatSpeed(): { value: string; unit: string } { return { value: '1', unit: 'ms/s' }; }

  // -------------------------------------------------------------------------
  // Clock management
  // -------------------------------------------------------------------------

  advanceClocks(): void { /* no-op */ }

  // -------------------------------------------------------------------------
  // Visualization context
  // -------------------------------------------------------------------------

  getPinVoltages(_element: CircuitElement): Map<string, number> | null { return null; }
  getWireAnalogNodeId(_wire: Wire): number | undefined { return undefined; }

  readonly voltageRange: { min: number; max: number } | null = null;
  updateVoltageTracking(): void { /* no-op */ }

  // -------------------------------------------------------------------------
  // Slider context
  // -------------------------------------------------------------------------

  getSliderProperties(_element: CircuitElement): SliderPropertyDescriptor[] { return []; }
  setComponentProperty(_element: CircuitElement, _key: string, _value: number): void { /* no-op */ }

  // -------------------------------------------------------------------------
  // Measurement signal reading
  // -------------------------------------------------------------------------

  readElementCurrent(_elementIndex: number): number | null { return null; }
  readBranchCurrent(_branchIndex: number): number | null { return null; }
  readElementPower(_elementIndex: number): number | null { return null; }

  // -------------------------------------------------------------------------
  // Snapshot management
  // -------------------------------------------------------------------------

  saveSnapshot(): SnapshotId { return 0 as SnapshotId; }
  restoreSnapshot(_id: SnapshotId): void { /* no-op */ }

  // -------------------------------------------------------------------------
  // Current resolver context
  // -------------------------------------------------------------------------

  getCurrentResolverContext(): CurrentResolverContext | null { return null; }
}
