/**
 * FSM to state transition table conversion.
 *
 * Port of Digital's TransitionTableCreator. Converts an FSM model into a
 * StateTransitionTable compatible with the Phase 8 analysis pipeline.
 *
 * Process:
 *   1. Encode each state using the FSM's configured encoding scheme.
 *   2. For each (current state encoding, input combination):
 *      - Evaluate transition conditions to find the matching transition.
 *      - Record the next-state encoding and outputs.
 *   3. If no transition matches, the state stays unchanged and outputs are 0.
 */

import type { FSM, FSMState, FSMTransition } from './model.js';
import { encodeStates, stateBitsRequired } from './state-encoding.js';
import type {
  SignalSpec,
  StateTransition,
  StateTransitionTable,
} from '../analysis/state-transition.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an FSM to a StateTransitionTable.
 *
 * The resulting table has:
 *   - stateVars: one entry per state bit (named Z_0, Z_1, ... with bitWidth 1)
 *   - inputs: one entry per FSM input signal (bitWidth 1)
 *   - outputs: one entry per FSM output signal (bitWidth 1)
 *   - transitions: one entry per (state, input) combination
 */
export function fsmToTransitionTable(fsm: FSM): StateTransitionTable {
  const stateCount = fsm.states.length;
  if (stateCount === 0) {
    return { stateVars: [], inputs: [], outputs: [], transitions: [] };
  }

  const encoding = fsm.stateEncoding;
  const stateMap = encodeStates(fsm.states, encoding);
  const numStateBits = stateBitsRequired(stateCount, encoding);

  const stateVars: SignalSpec[] = [];
  for (let i = numStateBits - 1; i >= 0; i--) {
    stateVars.push({ name: `Z_${i}`, bitWidth: 1 });
  }

  const inputs: SignalSpec[] = fsm.inputSignals.map((name) => ({
    name,
    bitWidth: 1,
  }));

  const outputs: SignalSpec[] = fsm.outputSignals.map((name) => ({
    name,
    bitWidth: 1,
  }));

  const numInputBits = inputs.length;
  const totalStateCombinations = 1 << numStateBits;
  const totalInputCombinations = 1 << numInputBits;

  const stateById = new Map<string, FSMState>();
  for (const state of fsm.states) {
    stateById.set(state.id, state);
  }

  const encodingToState = new Map<bigint, FSMState>();
  for (const state of fsm.states) {
    encodingToState.set(stateMap.get(state.id)!, state);
  }

  const transitions: StateTransition[] = [];

  for (let stateIdx = 0; stateIdx < totalStateCombinations; stateIdx++) {
    const stateValue = BigInt(stateIdx);
    const currentState = decomposeToBits(stateValue, numStateBits);

    const sourceState = encodingToState.get(stateValue);

    for (let inputIdx = 0; inputIdx < totalInputCombinations; inputIdx++) {
      const inputValues = decomposeToBits(BigInt(inputIdx), numInputBits);

      let nextStateValue: bigint;
      let outputValues: bigint[];

      if (sourceState === undefined) {
        nextStateValue = stateValue;
        outputValues = outputs.map(() => 0n);
      } else {
        const inputMap = buildInputMap(fsm.inputSignals, inputIdx);
        const matchingTransition = findMatchingTransition(
          fsm.transitions,
          sourceState.id,
          inputMap,
        );

        if (matchingTransition !== undefined) {
          nextStateValue = stateMap.get(matchingTransition.targetStateId)!;
          outputValues = resolveOutputs(
            fsm.outputSignals,
            sourceState,
            matchingTransition,
          );
        } else {
          nextStateValue = stateValue;
          outputValues = resolveMooreOutputs(fsm.outputSignals, sourceState);
        }
      }

      const nextState = decomposeToBits(nextStateValue, numStateBits);

      transitions.push({
        currentState,
        input: inputValues,
        nextState,
        output: outputValues,
      });
    }
  }

  return { stateVars, inputs, outputs, transitions };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decompose a bigint value into an array of 1-bit bigint values, MSB first.
 */
function decomposeToBits(value: bigint, bitCount: number): bigint[] {
  const bits: bigint[] = [];
  for (let i = bitCount - 1; i >= 0; i--) {
    bits.push((value >> BigInt(i)) & 1n);
  }
  return bits;
}

/**
 * Build a map from input signal names to their boolean values for a given
 * input combination index.
 */
function buildInputMap(
  inputSignals: readonly string[],
  inputIdx: number,
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (let i = 0; i < inputSignals.length; i++) {
    const bitPos = inputSignals.length - 1 - i;
    map.set(inputSignals[i]!, ((inputIdx >> bitPos) & 1) === 1);
  }
  return map;
}

/**
 * Find the first transition from the given source state whose condition
 * is satisfied by the given input values.
 *
 * Unconditional transitions (empty condition) always match.
 * Conditions are evaluated as boolean expressions over the input signal names.
 */
function findMatchingTransition(
  transitions: readonly FSMTransition[],
  sourceStateId: string,
  inputMap: Map<string, boolean>,
): FSMTransition | undefined {
  const outgoing = transitions.filter((t) => t.sourceStateId === sourceStateId);

  for (const t of outgoing) {
    const condition = t.condition.trim();
    if (condition.length === 0) {
      return t;
    }
    if (evaluateCondition(condition, inputMap)) {
      return t;
    }
  }

  return undefined;
}

/**
 * Resolve output values for a transition.
 * Moore outputs come from the source state.
 * Mealy outputs (transition actions) override Moore outputs.
 */
function resolveOutputs(
  outputSignals: readonly string[],
  sourceState: FSMState,
  transition: FSMTransition,
): bigint[] {
  return outputSignals.map((name) => {
    if (transition.actions !== undefined && name in transition.actions) {
      return BigInt(transition.actions[name]!) & 1n;
    }
    if (name in sourceState.outputs) {
      return BigInt(sourceState.outputs[name]!) & 1n;
    }
    return 0n;
  });
}

/**
 * Resolve Moore-only outputs from a state (no matching transition).
 */
function resolveMooreOutputs(
  outputSignals: readonly string[],
  state: FSMState,
): bigint[] {
  return outputSignals.map((name) => {
    if (name in state.outputs) {
      return BigInt(state.outputs[name]!) & 1n;
    }
    return 0n;
  });
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a boolean condition expression given input signal values.
 *
 * Supports: & (AND), | (OR), ! / ~ (NOT), parentheses, identifiers,
 * numeric constants (0, 1), and identifier=value comparisons.
 */
function evaluateCondition(
  input: string,
  values: Map<string, boolean>,
): boolean {
  let pos = 0;

  function skipWS(): void {
    while (pos < input.length && (input[pos] === ' ' || input[pos] === '\t')) {
      pos++;
    }
  }

  function parseExpr(): boolean {
    return parseOrExpr();
  }

  function parseOrExpr(): boolean {
    let result = parseAndExpr();
    skipWS();
    while (pos < input.length && (input[pos] === '|' || input[pos] === '+')) {
      pos++;
      skipWS();
      result = parseAndExpr() || result;
      skipWS();
    }
    return result;
  }

  function parseAndExpr(): boolean {
    let result = parseNotExpr();
    skipWS();
    while (pos < input.length && (input[pos] === '&' || input[pos] === '*')) {
      pos++;
      skipWS();
      result = parseNotExpr() && result;
      skipWS();
    }
    return result;
  }

  function parseNotExpr(): boolean {
    skipWS();
    if (pos < input.length && (input[pos] === '!' || input[pos] === '~')) {
      pos++;
      skipWS();
      return !parseNotExpr();
    }
    return parseAtom();
  }

  function parseAtom(): boolean {
    skipWS();

    if (pos < input.length && input[pos] === '(') {
      pos++;
      const result = parseExpr();
      skipWS();
      if (pos < input.length && input[pos] === ')') {
        pos++;
      }
      return result;
    }

    if (pos < input.length && /[0-9]/.test(input[pos]!)) {
      let numStr = '';
      while (pos < input.length && /[0-9]/.test(input[pos]!)) {
        numStr += input[pos];
        pos++;
      }
      return parseInt(numStr, 10) !== 0;
    }

    if (pos < input.length && /[A-Za-z_]/.test(input[pos]!)) {
      let name = '';
      while (pos < input.length && /[A-Za-z0-9_]/.test(input[pos]!)) {
        name += input[pos];
        pos++;
      }
      skipWS();
      if (pos < input.length && input[pos] === '=') {
        pos++;
        skipWS();
        let valStr = '';
        while (pos < input.length && /[0-9]/.test(input[pos]!)) {
          valStr += input[pos];
          pos++;
        }
        const expected = parseInt(valStr, 10);
        const actual = values.get(name) ? 1 : 0;
        return actual === expected;
      }
      return values.get(name) ?? false;
    }

    return false;
  }

  return parseExpr();
}
