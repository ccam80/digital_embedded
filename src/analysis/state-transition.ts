/**
 * State transition table analysis for sequential circuits.
 *
 * Identifies state variables (flip-flop Q outputs), enumerates all
 * (state, input) combinations, steps the engine one clock cycle for each,
 * and records the next-state and output values.
 */

import type { Circuit as _Circuit } from '../core/circuit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalSpec {
  readonly name: string;
  readonly bitWidth: number;
}

export interface StateTransition {
  readonly currentState: bigint[];
  readonly input: bigint[];
  readonly nextState: bigint[];
  readonly output: bigint[];
}

export interface StateTransitionTable {
  readonly stateVars: SignalSpec[];
  readonly inputs: SignalSpec[];
  readonly outputs: SignalSpec[];
  readonly transitions: StateTransition[];
}

/**
 * Minimal simulation facade for state transition analysis.
 */
export interface SequentialAnalysisFacade {
  /** Force a flip-flop state variable to a specific value. */
  setStateValue(name: string, value: bigint): void;
  /** Set an input signal value. */
  setInput(name: string, value: bigint): void;
  /** Run one clock cycle. */
  clockStep(): void;
  /** Read the current value of a state variable (flip-flop Q). */
  getStateValue(name: string): bigint;
  /** Read an output signal value. */
  getOutput(name: string): bigint;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Analyse a sequential circuit and produce its state transition table.
 *
 * @param facade  Simulation facade with state access.
 * @param circuit The circuit to analyse.
 * @param stateVars  State variable specs (flip-flop Q signals).
 * @param inputs     Input signal specs.
 * @param outputs    Output signal specs.
 * @returns State transition table.
 * @throws Error if no state variables are found.
 */
export function analyseSequential(
  facade: SequentialAnalysisFacade,
  stateVars: SignalSpec[],
  inputs: SignalSpec[],
  outputs: SignalSpec[],
): StateTransitionTable {
  if (stateVars.length === 0) {
    throw new Error(
      'analyseSequential: no state variables found. ' +
        'This is a purely combinational circuit- use analyseCircuit instead.',
    );
  }

  const totalStateBits = stateVars.reduce((s, v) => s + v.bitWidth, 0);
  const totalInputBits = inputs.reduce((s, v) => s + v.bitWidth, 0);
  const totalCombinations = (1 << totalStateBits) * (1 << totalInputBits);

  const transitions: StateTransition[] = [];

  for (let combo = 0; combo < totalCombinations; combo++) {
    const stateBits = combo >> totalInputBits;
    const inputBits = combo & ((1 << totalInputBits) - 1);

    // Decompose state bits into per-variable values
    const stateValues = decompose(stateBits, stateVars, totalStateBits);
    const inputValues = decompose(inputBits, inputs, totalInputBits);

    // Apply state and inputs
    for (let i = 0; i < stateVars.length; i++) {
      facade.setStateValue(stateVars[i]!.name, stateValues[i]!);
    }
    for (let i = 0; i < inputs.length; i++) {
      facade.setInput(inputs[i]!.name, inputValues[i]!);
    }

    // Clock step
    facade.clockStep();

    // Read next state and outputs
    const nextState = stateVars.map((v) => facade.getStateValue(v.name));
    const output = outputs.map((v) => facade.getOutput(v.name));

    transitions.push({
      currentState: stateValues,
      input: inputValues,
      nextState,
      output,
    });
  }

  return { stateVars, inputs, outputs, transitions };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decompose(bits: number, specs: SignalSpec[], totalBits: number): bigint[] {
  const values: bigint[] = [];
  let bitOffset = totalBits - 1;

  for (const spec of specs) {
    let val = 0n;
    for (let b = spec.bitWidth - 1; b >= 0; b--) {
      if ((bits >> bitOffset) & 1) {
        val |= 1n << BigInt(b);
      }
      bitOffset--;
    }
    values.push(val);
  }

  return values;
}
