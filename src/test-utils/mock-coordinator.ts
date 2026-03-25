/**
 * Mock SimulationCoordinator for unit tests.
 *
 * Backed by a simple Map<SignalAddress, SignalValue> store. Tests inject
 * values via setSignal() and assert on writeSignal() calls via the
 * writeCalls record.
 */

import type { SimulationEngine, MeasurementObserver } from "@/core/engine-interface";
import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { SimulationCoordinator } from "@/solver/coordinator-types";
import type { CompiledCircuitUnified, SignalAddress, SignalValue } from "@/compile/types";

export type WriteCall = { addr: SignalAddress; value: SignalValue };

export class MockCoordinator implements SimulationCoordinator {
  readonly writeCalls: WriteCall[] = [];

  private _signals: Map<string, SignalValue> = new Map();
  private _digitalBackend: SimulationEngine | null = null;
  private _analogBackend: AnalogEngine | null = null;

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

  addMeasurementObserver(_observer: MeasurementObserver): void { /* no-op */ }
  removeMeasurementObserver(_observer: MeasurementObserver): void { /* no-op */ }

  get digitalBackend(): SimulationEngine | null {
    return this._digitalBackend;
  }

  get analogBackend(): AnalogEngine | null {
    return this._analogBackend;
  }

  get compiled(): CompiledCircuitUnified {
    return {
      digital: null,
      analog: null,
      bridges: [],
      wireSignalMap: new Map(),
      labelSignalMap: new Map(),
      diagnostics: [],
    };
  }
}
