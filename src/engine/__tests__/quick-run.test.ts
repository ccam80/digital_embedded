/**
 * Tests for QuickRun and SpeedTest — task 3.4.4.
 *
 * Verifies that quickRun suppresses listeners during execution and restores
 * them afterwards, and that speedTest reports meaningful metrics.
 */

import { describe, it, expect, vi } from "vitest";
import { quickRun, speedTest } from "../quick-run.js";
import { DigitalEngine, type ConcreteCompiledCircuit, type EvaluationGroup } from "../digital-engine.js";
import type { ComponentLayout } from "@/core/registry";
import type { Wire } from "@/core/circuit";

// ---------------------------------------------------------------------------
// StaticLayout and buildCircuit helpers
// ---------------------------------------------------------------------------

class StaticLayout implements ComponentLayout {
  readonly wiringTable: Int32Array;
  private readonly _inputOffsets: number[];
  private readonly _outputOffsets: number[];
  private readonly _inputCounts: number[];
  private readonly _outputCounts: number[];

  constructor(inputNets: number[][], outputNets: number[][]) {
    const entries: number[] = [];
    this._inputOffsets = [];
    this._outputOffsets = [];
    this._inputCounts = inputNets.map(n => n.length);
    this._outputCounts = outputNets.map(n => n.length);
    for (const nets of inputNets) {
      this._inputOffsets.push(entries.length);
      for (const netId of nets) entries.push(netId);
    }
    for (const nets of outputNets) {
      this._outputOffsets.push(entries.length);
      for (const netId of nets) entries.push(netId);
    }
    this.wiringTable = Int32Array.from(entries);
  }

  inputCount(i: number): number { return this._inputCounts[i] ?? 0; }
  inputOffset(i: number): number { return this._inputOffsets[i] ?? 0; }
  outputCount(i: number): number { return this._outputCounts[i] ?? 0; }
  outputOffset(i: number): number { return this._outputOffsets[i] ?? 0; }
  stateOffset(_i: number): number { return 0; }
}

function singleGroup(indices: number[]): EvaluationGroup {
  return { componentIndices: new Uint32Array(indices), isFeedback: false };
}

function buildMinimalCircuit(): ConcreteCompiledCircuit {
  const noopFn = (_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void => {};
  const layout = new StaticLayout([[0]], [[1]]);
  return {
    netCount: 2,
    componentCount: 1,
    typeIds: new Uint8Array([0]),
    executeFns: [noopFn],
    sampleFns: [null],
    wiringTable: layout.wiringTable,
    layout,
    evaluationOrder: [singleGroup([0])],
    sequentialComponents: new Uint32Array(0),
    netWidths: new Uint8Array(2).fill(1),
    sccSnapshotBuffer: new Uint32Array(2),
    delays: new Uint32Array(1).fill(10),
    componentToElement: new Map(),
    labelToNetId: new Map(),
    wireToNetId: new Map<Wire, number>(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    busResolver: null,
    totalStateSlots: 0,
    signalArraySize: 2,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QuickRun", () => {
  // -------------------------------------------------------------------------
  // runsWithoutListeners
  // -------------------------------------------------------------------------

  it("runsWithoutListeners — register listener, quickRun 100 steps, verify listener was NOT called during run", () => {
    const engine = new DigitalEngine("level");
    engine.init(buildMinimalCircuit());

    const listener = vi.fn();
    engine.addChangeListener(listener);

    quickRun(engine, 100);

    // The change listener fires on state transitions (RUNNING/PAUSED/STOPPED).
    // During quickRun the listener is suppressed, so it must not have been called.
    expect(listener).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // restoresListenersAfter
  // -------------------------------------------------------------------------

  it("restoresListenersAfter — quickRun, then normal step triggers state change, verify listener IS called", () => {
    const engine = new DigitalEngine("level");
    engine.init(buildMinimalCircuit());

    const listener = vi.fn();
    engine.addChangeListener(listener);

    // quickRun suppresses listeners
    quickRun(engine, 10);

    // After quickRun, listeners must be restored.
    // Trigger a state change by starting the engine (STOPPED → RUNNING).
    engine.start();
    engine.stop();

    // The listener should have been called for the state transitions after
    // quickRun completed (at least once for start and/or stop).
    expect(listener).toHaveBeenCalled();
  });
});

describe("SpeedTest", () => {
  // -------------------------------------------------------------------------
  // reportsMetrics
  // -------------------------------------------------------------------------

  it("reportsMetrics — speedTest 1000 steps, verify result has positive stepsPerSecond", () => {
    const engine = new DigitalEngine("level");
    engine.init(buildMinimalCircuit());

    const result = speedTest(engine, 1000);

    expect(result.steps).toBe(1000);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.stepsPerSecond).toBeGreaterThan(0);
    expect(result.khz).toBeGreaterThan(0);
    // khz must equal stepsPerSecond / 1000
    expect(result.khz).toBeCloseTo(result.stepsPerSecond / 1000, 6);
  });
});
