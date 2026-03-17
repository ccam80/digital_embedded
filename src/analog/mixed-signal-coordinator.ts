/**
 * MixedSignalCoordinator — timing synchronization between the outer analog
 * engine and inner digital engines at cross-engine subcircuit boundaries.
 *
 * On each analog timestep the coordinator:
 *   1. Reads analog voltages at bridge input adapter nodes.
 *   2. Converts to digital bits via threshold detection.
 *   3. Feeds bits to the inner digital engine.
 *   4. Steps the inner digital engine.
 *   5. Reads digital outputs.
 *   6. Updates bridge output adapters with new logic levels.
 *   7. Registers breakpoints for the next expected transitions.
 *
 * After each accepted timestep the coordinator checks for threshold crossings
 * on analog input nodes and re-evaluates the digital engine when a crossing
 * is detected.
 */

import { DigitalEngine } from "../engine/digital-engine.js";
import { BitVector } from "../core/signal.js";
import type { MNAEngine } from "./analog-engine.js";
import type { BridgeInstance } from "./bridge-instance.js";

// ---------------------------------------------------------------------------
// Per-bridge internal state
// ---------------------------------------------------------------------------

interface BridgeState {
  innerEngine: DigitalEngine;
  prevInputBits: boolean[];
  prevOutputBits: boolean[];
  prevInputVoltages: number[];
}

// ---------------------------------------------------------------------------
// MixedSignalCoordinator
// ---------------------------------------------------------------------------

/**
 * Sits between MNAEngine and its bridge instances, orchestrating stepping
 * between the outer analog engine and each inner digital engine.
 */
export class MixedSignalCoordinator {
  private readonly _analogEngine: MNAEngine;
  private readonly _bridgeStates: BridgeState[];

  readonly bridges: BridgeInstance[];

  constructor(analogEngine: MNAEngine, bridges: BridgeInstance[]) {
    this._analogEngine = analogEngine;
    this.bridges = bridges;
    this._bridgeStates = bridges.map(() => ({
      innerEngine: new DigitalEngine("level"),
      prevInputBits: [],
      prevOutputBits: [],
      prevInputVoltages: [],
    }));
  }

  /**
   * Create a DigitalEngine for each bridge and initialise it with the
   * compiled inner circuit.
   */
  init(): void {
    for (let b = 0; b < this.bridges.length; b++) {
      const bridge = this.bridges[b]!;
      const state = this._bridgeStates[b]!;

      state.innerEngine = new DigitalEngine("level");
      state.innerEngine.init(bridge.compiledInner);

      state.prevInputBits = bridge.inputAdapters.map(() => false);
      state.prevOutputBits = bridge.outputAdapters.map(() => false);
      state.prevInputVoltages = bridge.inputAdapters.map(() => 0);
    }
  }

  /**
   * Called by MNAEngine before each analog timestep.
   *
   * Reads analog input voltages, converts to digital bits, steps each inner
   * engine, reads digital outputs, updates bridge output adapters, and
   * registers a breakpoint on the analog engine if any output changed.
   */
  syncBeforeAnalogStep(voltages: Float64Array): void {
    for (let b = 0; b < this.bridges.length; b++) {
      const bridge = this.bridges[b]!;
      const state = this._bridgeStates[b]!;

      // Feed analog voltages to inner engine as digital inputs
      for (let i = 0; i < bridge.inputAdapters.length; i++) {
        const adapter = bridge.inputAdapters[i]!;
        const netId = bridge.inputPinNetIds[i]!;
        const nodeId = adapter.inputNodeId;
        const voltage = nodeId < voltages.length ? voltages[nodeId] : 0;
        const level = adapter.readLogicLevel(voltage);

        // Treat indeterminate as previous value (hold last known state)
        const bit = level !== undefined ? level : state.prevInputBits[i] ?? false;
        state.prevInputBits[i] = bit;

        state.innerEngine.setSignalValue(netId, BitVector.fromNumber(bit ? 1 : 0, 1));
      }

      // Step the inner digital engine
      state.innerEngine.step();

      // Read digital outputs and update bridge output adapters
      let anyOutputChanged = false;
      for (let o = 0; o < bridge.outputAdapters.length; o++) {
        const adapter = bridge.outputAdapters[o]!;
        const netId = bridge.outputPinNetIds[o]!;

        const rawValue = state.innerEngine.getSignalRaw(netId);
        const signalValue = state.innerEngine.getSignalValue(netId);

        // Check for Hi-Z: if the signal is high-Z treat as Hi-Z output
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

      // Register a breakpoint so the timestep controller lands on this transition
      if (anyOutputChanged) {
        this._analogEngine.addBreakpoint(this._analogEngine.simTime);
      }
    }
  }

  /**
   * Called by MNAEngine after each accepted timestep.
   *
   * Checks for threshold crossings on analog input nodes. If a crossing is
   * detected (the analog voltage moved from one side of a threshold to the
   * other), re-evaluates the digital engine with the updated inputs.
   */
  syncAfterAnalogStep(voltages: Float64Array): void {
    for (let b = 0; b < this.bridges.length; b++) {
      const bridge = this.bridges[b]!;
      const state = this._bridgeStates[b]!;

      let crossingDetected = false;

      for (let i = 0; i < bridge.inputAdapters.length; i++) {
        const adapter = bridge.inputAdapters[i]!;
        const nodeId = adapter.inputNodeId;
        const prevVoltage = state.prevInputVoltages[i] ?? 0;
        const currVoltage = nodeId < voltages.length ? voltages[nodeId] : 0;

        const prevLevel = adapter.readLogicLevel(prevVoltage);
        const currLevel = adapter.readLogicLevel(currVoltage);

        // A crossing occurred when the logic-level interpretation changed:
        // this includes entering/exiting the indeterminate band as well as
        // direct low→high or high→low transitions.
        if (prevLevel !== currLevel) {
          crossingDetected = true;
        }

        state.prevInputVoltages[i] = currVoltage;
      }

      if (crossingDetected) {
        // Re-sync with the updated voltages
        for (let i = 0; i < bridge.inputAdapters.length; i++) {
          const adapter = bridge.inputAdapters[i]!;
          const netId = bridge.inputPinNetIds[i]!;
          const nodeId = adapter.inputNodeId;
          const voltage = nodeId < voltages.length ? voltages[nodeId] : 0;
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

  /** Reset all inner digital engines to their initial state. */
  reset(): void {
    for (const state of this._bridgeStates) {
      state.innerEngine.reset();
      state.prevInputBits.fill(false);
      state.prevOutputBits.fill(false);
      state.prevInputVoltages.fill(0);
    }
  }

  /** Dispose all inner digital engines. */
  dispose(): void {
    for (const state of this._bridgeStates) {
      state.innerEngine.dispose();
    }
  }
}
