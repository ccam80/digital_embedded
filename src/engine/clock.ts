/**
 * ClockManager — identifies clock sources and manages clock toggling.
 *
 * After compilation, ClockManager scans the compiled circuit for Clock
 * components and tracks their phase state. On each call to advanceClocks(),
 * every clock's output net is toggled in the signal state array and the
 * edges that fired are returned for sequential element evaluation.
 *
 * Multiple clock domains with independent frequencies are supported. Each
 * clock tracks a step counter; a clock fires every N steps where N is derived
 * from its frequency property. Frequency semantics: the value is "steps per
 * half-period", meaning the output toggles once per `frequency` engine steps.
 * A clock with frequency=1 toggles every step, frequency=2 toggles every 2
 * steps, etc.
 *
 * Real-time mode paces clock advancement to wall-clock time by deferring
 * calls to advanceClocks() until the appropriate interval has elapsed.
 *
 */

import type { CompiledCircuit } from "@/core/engine-interface";
import type { ConcreteCompiledCircuit } from "./digital-engine.js";

// ---------------------------------------------------------------------------
// ClockEdge
// ---------------------------------------------------------------------------

/** The type of clock transition that occurred. */
export type ClockEdge = "rising" | "falling";

// ---------------------------------------------------------------------------
// ClockInfo — describes one Clock component in the circuit
// ---------------------------------------------------------------------------

/**
 * State for a single Clock component instance.
 *
 * frequency: steps per half-period (how many advanceClocks calls before
 *            the output toggles). A value of 1 means toggle every step.
 * currentPhase: current output value (false=0, true=1).
 * stepsSinceToggle: how many advanceClocks calls since last toggle.
 */
export interface ClockInfo {
  /** Component index in the compiled circuit. */
  readonly componentIndex: number;
  /** Output net ID driven by this clock. */
  readonly netId: number;
  /**
   * Steps per half-period. The clock output toggles once per this many
   * advanceClocks calls. Derived from the Clock element's Frequency property.
   */
  readonly frequency: number;
  /** Current output phase (false = low, true = high). */
  currentPhase: boolean;
  /** Steps elapsed since the last toggle. */
  stepsSinceToggle: number;
}

// ---------------------------------------------------------------------------
// FiredEdge — a clock edge that fired during advanceClocks()
// ---------------------------------------------------------------------------

export interface FiredEdge {
  readonly clockInfo: ClockInfo;
  readonly edge: ClockEdge;
}

// ---------------------------------------------------------------------------
// ClockManager
// ---------------------------------------------------------------------------

/**
 * Manages all Clock components in a compiled circuit.
 *
 * Usage:
 *   const mgr = new ClockManager(compiled);
 *   const edges = mgr.advanceClocks(state);
 *   for (const {edge, clockInfo} of edges) {
 *     const seqComponents = mgr.getSequentialComponentsForEdge(edge);
 *     // evaluate sequential components that sample on this edge
 *   }
 */
export class ClockManager {
  private readonly _compiled: ConcreteCompiledCircuit | null;
  private _clocks: ClockInfo[] = [];
  private _realTimeMode = false;
  private _targetFrequencyHz = 0;
  private _lastRealTimeTick = 0;

  constructor(compiled: CompiledCircuit) {
    // Accept both concrete and opaque CompiledCircuit. For opaque circuits
    // (e.g. mock CompiledCircuit in tests that don't provide componentToElement),
    // findClocks() will return an empty list.
    if (isConcreteCompiledCircuit(compiled)) {
      this._compiled = compiled;
    } else {
      this._compiled = null;
    }
    this._clocks = this._findClocksInternal();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return info for all Clock components found in the compiled circuit.
   *
   * Called once after construction. The returned array is the same mutable
   * array held internally — callers should not modify it.
   */
  findClocks(): ClockInfo[] {
    return this._clocks;
  }

  /**
   * Advance all clock counters by one step.
   *
   * For each clock whose counter reaches its half-period, the clock output
   * in the state array is toggled and the edge type is recorded.
   *
   * Returns the list of edges that fired this step (may be empty).
   *
   * In real-time mode, toggles are only applied when the wall-clock interval
   * for the target frequency has elapsed; otherwise returns an empty list.
   *
   * @param state  Signal value array owned by the engine (Uint32Array).
   */
  advanceClocks(state: Uint32Array): FiredEdge[] {
    if (this._realTimeMode) {
      return this._advanceClocksRealTime(state);
    }
    return this._advanceClocksStep(state);
  }

  /**
   * Return the component indices of sequential elements that sample on the
   * given clock edge type.
   *
   * In the current implementation, all sequential components are evaluated on
   * rising edges (the most common convention). Falling-edge sampling would
   * require the component definition to declare its edge sensitivity.
   *
   * @param edge  The edge type that fired.
   */
  getSequentialComponentsForEdge(edge: ClockEdge): number[] {
    if (this._compiled === null) return [];
    if (edge === "rising") {
      return Array.from(this._compiled.sequentialComponents);
    }
    // Falling-edge triggered components are not yet modelled; return empty.
    return [];
  }

  /**
   * Enable or disable real-time clock pacing.
   *
   * When enabled, advanceClocks() uses Date.now() to determine whether the
   * interval for targetFrequency Hz has elapsed, rather than always toggling.
   *
   * @param enabled           Whether to enable real-time pacing.
   * @param targetFrequency   Target frequency in Hz (only used when enabled).
   */
  setRealTimeMode(enabled: boolean, targetFrequency?: number): void {
    this._realTimeMode = enabled;
    if (enabled) {
      this._targetFrequencyHz = targetFrequency ?? 1;
      this._lastRealTimeTick = Date.now();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _findClocksInternal(): ClockInfo[] {
    if (this._compiled === null) return [];

    const { componentToElement, layout } = this._compiled;
    const clocks: ClockInfo[] = [];

    for (const [componentIndex, element] of componentToElement.entries()) {
      if (element.typeId !== "Clock") continue;

      // Output net ID: the clock has one output pin. layout.outputOffset(i)
      // returns the net ID of the first output.
      const netId = layout.outputOffset(componentIndex);

      // Read the Frequency property from the element via the standard
      // getAttribute interface. ClockElement stores frequency as the
      // "Frequency" property key (matching the .dig XML attribute name).
      let frequency = 1;
      const freqAttr = element.getAttribute("Frequency");
      if (typeof freqAttr === "number" && freqAttr > 0) {
        frequency = freqAttr;
      }

      clocks.push({
        componentIndex,
        netId,
        frequency,
        currentPhase: false,
        stepsSinceToggle: 0,
      });
    }

    return clocks;
  }

  private _advanceClocksStep(state: Uint32Array): FiredEdge[] {
    const fired: FiredEdge[] = [];

    for (const clock of this._clocks) {
      clock.stepsSinceToggle++;

      if (clock.stepsSinceToggle >= clock.frequency) {
        clock.stepsSinceToggle = 0;
        this._toggleClock(clock, state, fired);
      }
    }

    return fired;
  }

  private _advanceClocksRealTime(state: Uint32Array): FiredEdge[] {
    const now = Date.now();
    const elapsed = now - this._lastRealTimeTick;
    // Half-period in ms for the target frequency
    const halfPeriodMs = this._targetFrequencyHz > 0
      ? 1000 / (2 * this._targetFrequencyHz)
      : 1000;

    if (elapsed < halfPeriodMs) {
      return [];
    }

    this._lastRealTimeTick = now;
    const fired: FiredEdge[] = [];

    for (const clock of this._clocks) {
      this._toggleClock(clock, state, fired);
    }

    return fired;
  }

  private _toggleClock(clock: ClockInfo, state: Uint32Array, fired: FiredEdge[]): void {
    clock.currentPhase = !clock.currentPhase;

    if (clock.netId < state.length) {
      state[clock.netId] = clock.currentPhase ? 1 : 0;
    }

    const edge: ClockEdge = clock.currentPhase ? "rising" : "falling";
    fired.push({ clockInfo: clock, edge });
  }
}

// ---------------------------------------------------------------------------
// Type narrowing helper
// ---------------------------------------------------------------------------

function isConcreteCompiledCircuit(c: CompiledCircuit): c is ConcreteCompiledCircuit {
  return (
    "componentToElement" in c &&
    "layout" in c &&
    "sequentialComponents" in c
  );
}
