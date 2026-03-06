/**
 * FSM state minimization via partition refinement.
 *
 * Two states are equivalent if:
 *   - They have the same Moore outputs
 *   - For every input combination, they transition to equivalent states
 *
 * Algorithm (iterative partition refinement):
 *   1. Initial partition: group states by their output values.
 *   2. Refine: split groups where states transition to different groups
 *      for any input combination.
 *   3. Repeat until the partition is stable.
 *   4. Merge equivalent states within each group.
 */

import type { FSM, FSMState, FSMTransition } from './model.js';
import { createFSM, addState, addTransition } from './model.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Optimize an FSM by merging equivalent states.
 *
 * Returns a new FSM with equivalent states merged. The original FSM is
 * not modified. If the FSM is already minimal, returns a new FSM with
 * the same state count.
 */
export function optimizeFSM(fsm: FSM): FSM {
  if (fsm.states.length <= 1) {
    return cloneFSM(fsm);
  }

  const inputCombinations = enumerateInputCombinations(fsm.inputSignals);
  const transitionMap = buildTransitionMap(fsm, inputCombinations);

  // Step 1: Initial partition by output values
  let partition = initialPartition(fsm.states);

  // Step 2-3: Refine until stable
  let changed = true;
  while (changed) {
    changed = false;
    const newPartition: FSMState[][] = [];

    for (const group of partition) {
      const splits = refineGroup(group, partition, transitionMap, inputCombinations);
      if (splits.length > 1) {
        changed = true;
      }
      for (const split of splits) {
        newPartition.push(split);
      }
    }

    partition = newPartition;
  }

  // Step 4: Build new FSM with merged states
  return buildMergedFSM(fsm, partition, transitionMap, inputCombinations);
}

// ---------------------------------------------------------------------------
// Input combination enumeration
// ---------------------------------------------------------------------------

interface InputCombination {
  values: Map<string, boolean>;
}

function enumerateInputCombinations(inputSignals: readonly string[]): InputCombination[] {
  const count = 1 << inputSignals.length;
  const combinations: InputCombination[] = [];

  for (let i = 0; i < count; i++) {
    const values = new Map<string, boolean>();
    for (let j = 0; j < inputSignals.length; j++) {
      const bitPos = inputSignals.length - 1 - j;
      values.set(inputSignals[j]!, ((i >> bitPos) & 1) === 1);
    }
    combinations.push({ values });
  }

  return combinations;
}

// ---------------------------------------------------------------------------
// Transition map
// ---------------------------------------------------------------------------

/**
 * For each (stateId, inputCombinationIndex), store the target state ID.
 * If no transition matches, the state stays in itself.
 */
type TransitionLookup = Map<string, string[]>;

function buildTransitionMap(
  fsm: FSM,
  inputCombinations: InputCombination[],
): TransitionLookup {
  const lookup: TransitionLookup = new Map();

  for (const state of fsm.states) {
    const targets: string[] = [];
    const outgoing = fsm.transitions.filter((t) => t.sourceStateId === state.id);

    for (const combo of inputCombinations) {
      const matched = findMatchingTransition(outgoing, combo.values);
      targets.push(matched !== undefined ? matched.targetStateId : state.id);
    }

    lookup.set(state.id, targets);
  }

  return lookup;
}

function findMatchingTransition(
  transitions: FSMTransition[],
  inputValues: Map<string, boolean>,
): FSMTransition | undefined {
  for (const t of transitions) {
    const condition = t.condition.trim();
    if (condition.length === 0) {
      return t;
    }
    if (evaluateCondition(condition, inputValues)) {
      return t;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Partition refinement
// ---------------------------------------------------------------------------

/**
 * Initial partition: group states with identical Moore output values.
 */
function initialPartition(states: readonly FSMState[]): FSMState[][] {
  const groups = new Map<string, FSMState[]>();

  for (const state of states) {
    const key = outputKey(state);
    const group = groups.get(key);
    if (group !== undefined) {
      group.push(state);
    } else {
      groups.set(key, [state]);
    }
  }

  return [...groups.values()];
}

/**
 * Create a canonical string key from a state's output values.
 */
function outputKey(state: FSMState): string {
  const entries = Object.entries(state.outputs).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

/**
 * Find which group a state belongs to.
 */
function findGroupIndex(partition: FSMState[][], stateId: string): number {
  for (let i = 0; i < partition.length; i++) {
    if (partition[i]!.some((s) => s.id === stateId)) {
      return i;
    }
  }
  return -1;
}

/**
 * Refine a group by checking if all states in the group transition to
 * the same group for every input combination. If not, split.
 */
function refineGroup(
  group: FSMState[],
  partition: FSMState[][],
  transitionMap: TransitionLookup,
  inputCombinations: InputCombination[],
): FSMState[][] {
  if (group.length <= 1) {
    return [group];
  }

  const subgroups = new Map<string, FSMState[]>();

  for (const state of group) {
    const targets = transitionMap.get(state.id)!;
    const signature = targets
      .map((targetId) => findGroupIndex(partition, targetId))
      .join(',');

    const existing = subgroups.get(signature);
    if (existing !== undefined) {
      existing.push(state);
    } else {
      subgroups.set(signature, [state]);
    }
  }

  return [...subgroups.values()];
}

// ---------------------------------------------------------------------------
// Build merged FSM
// ---------------------------------------------------------------------------

function buildMergedFSM(
  original: FSM,
  partition: FSMState[][],
  transitionMap: TransitionLookup,
  inputCombinations: InputCombination[],
): FSM {
  const result = createFSM(original.name);
  result.inputSignals = [...original.inputSignals];
  result.outputSignals = [...original.outputSignals];
  result.stateEncoding = original.stateEncoding;

  // Pick a representative state for each group.
  // Prefer the initial state if present in the group.
  const representatives: FSMState[] = [];
  const stateToGroup = new Map<string, number>();

  for (let gi = 0; gi < partition.length; gi++) {
    const group = partition[gi]!;
    for (const state of group) {
      stateToGroup.set(state.id, gi);
    }

    const initialInGroup = group.find((s) => s.isInitial);
    const rep = initialInGroup ?? group[0]!;
    representatives.push(rep);
  }

  // Create new states
  const newStates: FSMState[] = [];
  for (const rep of representatives) {
    const isInitial = partition[stateToGroup.get(rep.id)!]!.some((s) => s.isInitial);
    const newState = addState(result, rep.name, { ...rep.position }, {
      outputs: { ...rep.outputs },
      isInitial,
      radius: rep.radius,
    });
    newStates.push(newState);
  }

  // Create transitions between merged groups.
  // For each group, for each input combination, add a transition to the target group.
  const addedTransitions = new Set<string>();

  for (let gi = 0; gi < partition.length; gi++) {
    const rep = representatives[gi]!;
    const targets = transitionMap.get(rep.id)!;
    const sourceState = newStates[gi]!;

    // Find original transitions from the representative
    const originalOutgoing = original.transitions.filter(
      (t) => t.sourceStateId === rep.id,
    );

    for (const origTransition of originalOutgoing) {
      const targetGroupIdx = stateToGroup.get(origTransition.targetStateId)!;
      const targetState = newStates[targetGroupIdx]!;

      const transKey = `${sourceState.id}->${targetState.id}:${origTransition.condition}`;
      if (addedTransitions.has(transKey)) continue;
      addedTransitions.add(transKey);

      addTransition(result, sourceState.id, targetState.id, origTransition.condition, {
        actions: origTransition.actions ? { ...origTransition.actions } : undefined,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// FSM cloning
// ---------------------------------------------------------------------------

function cloneFSM(fsm: FSM): FSM {
  const result = createFSM(fsm.name);
  result.inputSignals = [...fsm.inputSignals];
  result.outputSignals = [...fsm.outputSignals];
  result.stateEncoding = fsm.stateEncoding;
  result.stateBits = fsm.stateBits;

  const idMap = new Map<string, string>();

  for (const state of fsm.states) {
    const newState = addState(result, state.name, { ...state.position }, {
      outputs: { ...state.outputs },
      isInitial: state.isInitial,
      radius: state.radius,
    });
    idMap.set(state.id, newState.id);
  }

  for (const t of fsm.transitions) {
    addTransition(
      result,
      idMap.get(t.sourceStateId)!,
      idMap.get(t.targetStateId)!,
      t.condition,
      {
        actions: t.actions ? { ...t.actions } : undefined,
        controlPoints: t.controlPoints.map((p) => ({ ...p })),
      },
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Condition evaluator (same as in table-creator)
// ---------------------------------------------------------------------------

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
