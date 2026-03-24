import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFSM,
  addState,
  addTransition,
  resetIdCounter,
} from '../model.js';
import { optimizeFSM } from '../optimizer.js';

beforeEach(() => {
  resetIdCounter();
});

describe('optimizeFSM', () => {
  it('alreadyMinimal', () => {
    // Minimal FSM: 2 states with different outputs, no equivalence
    const fsm = createFSM('minimal');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s1.id, s0.id, 'A');

    const optimized = optimizeFSM(fsm);

    // Already minimal -> same state count
    expect(optimized.states).toHaveLength(2);
    expect(optimized.transitions.length).toBeGreaterThanOrEqual(2);
  });

  it('mergeEquivalent', () => {
    // FSM with 2 equivalent states (same outputs, same transitions to same groups)
    // S0 (Y=0) --A--> S1 (Y=1)
    // S0 (Y=0) --!A--> S2 (Y=1)  // S2 is equivalent to S1
    // S1 (Y=1) --A--> S0
    // S2 (Y=1) --A--> S0
    // S1 and S2 have same outputs and same transition behavior -> merge
    const fsm = createFSM('merge');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });
    const s2 = addState(fsm, 'S2', { x: 200, y: 0 }, { outputs: { Y: 1 } });

    // S0 -> S1 on A, S0 -> S2 on !A
    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s0.id, s2.id, '!A');

    // S1 and S2 both go to S0 on A, stay in themselves on !A
    addTransition(fsm, s1.id, s0.id, 'A');
    addTransition(fsm, s2.id, s0.id, 'A');

    const optimized = optimizeFSM(fsm);

    // S1 and S2 are equivalent -> merged into one
    expect(optimized.states).toHaveLength(2);

    // One state with Y=0, one with Y=1
    const outputValues = optimized.states.map((s) => s.outputs['Y']);
    expect(outputValues.sort()).toEqual([0, 1]);
  });

  it('functionalEquivalence', () => {
    // Verify original and optimized FSMs produce same output sequences
    const fsm = createFSM('equiv');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });
    const s2 = addState(fsm, 'S2', { x: 200, y: 0 }, { outputs: { Y: 1 } });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s0.id, s2.id, '!A');
    addTransition(fsm, s1.id, s0.id, 'A');
    addTransition(fsm, s1.id, s0.id, '!A');
    addTransition(fsm, s2.id, s0.id, 'A');
    addTransition(fsm, s2.id, s0.id, '!A');

    const optimized = optimizeFSM(fsm);

    // Simulate both FSMs with the same input sequences and verify outputs match.
    // Input sequences to test: [1,0,1,1,0], [0,0,1,0,1]
    const inputSequences = [
      [true, false, true, true, false],
      [false, false, true, false, true],
    ];

    for (const inputs of inputSequences) {
      const origOutputs = simulateFSM(fsm, inputs);
      const optOutputs = simulateFSM(optimized, inputs);
      expect(optOutputs).toEqual(origOutputs);
    }
  });

  it('preservesInitialState', () => {
    // Initial state preserved (or merged group keeps initial designation)
    const fsm = createFSM('initial');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 }, isInitial: true });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s1.id, s0.id, 'A');

    const optimized = optimizeFSM(fsm);

    // There should be exactly one initial state
    const initialStates = optimized.states.filter((s) => s.isInitial);
    expect(initialStates).toHaveLength(1);

    // The initial state should have the same outputs as the original initial state
    expect(initialStates[0]!.outputs['Y']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FSM simulator for functional equivalence testing
// ---------------------------------------------------------------------------

function simulateFSM(fsm: ReturnType<typeof createFSM>, inputs: boolean[]): number[] {
  const outputs: number[] = [];
  let currentState = fsm.states.find((s) => s.isInitial) ?? fsm.states[0]!;

  for (const inputVal of inputs) {
    // Record Moore output from current state
    const y = currentState.outputs['Y'] ?? 0;
    outputs.push(y);

    // Find matching transition
    const inputMap = new Map<string, boolean>();
    for (const sig of fsm.inputSignals) {
      inputMap.set(sig, inputVal);
    }

    const outgoing = fsm.transitions.filter((t) => t.sourceStateId === currentState.id);
    let nextState = currentState;

    for (const t of outgoing) {
      const cond = t.condition.trim();
      if (cond.length === 0 || evaluateSimple(cond, inputMap)) {
        const target = fsm.states.find((s) => s.id === t.targetStateId);
        if (target !== undefined) {
          nextState = target;
          break;
        }
      }
    }

    currentState = nextState;
  }

  return outputs;
}

function evaluateSimple(condition: string, values: Map<string, boolean>): boolean {
  let pos = 0;

  function skipWS(): void {
    while (pos < condition.length && condition[pos] === ' ') pos++;
  }

  function parseExpr(): boolean {
    return parseOr();
  }

  function parseOr(): boolean {
    let r = parseAnd();
    skipWS();
    while (pos < condition.length && (condition[pos] === '|' || condition[pos] === '+')) {
      pos++; skipWS();
      r = parseAnd() || r;
      skipWS();
    }
    return r;
  }

  function parseAnd(): boolean {
    let r = parseNot();
    skipWS();
    while (pos < condition.length && (condition[pos] === '&' || condition[pos] === '*')) {
      pos++; skipWS();
      r = parseNot() && r;
      skipWS();
    }
    return r;
  }

  function parseNot(): boolean {
    skipWS();
    if (pos < condition.length && (condition[pos] === '!' || condition[pos] === '~')) {
      pos++; skipWS();
      return !parseNot();
    }
    return parseAtom();
  }

  function parseAtom(): boolean {
    skipWS();
    if (pos < condition.length && condition[pos] === '(') {
      pos++;
      const r = parseExpr();
      skipWS();
      if (pos < condition.length && condition[pos] === ')') pos++;
      return r;
    }
    if (pos < condition.length && /[0-9]/.test(condition[pos]!)) {
      let n = '';
      while (pos < condition.length && /[0-9]/.test(condition[pos]!)) { n += condition[pos]; pos++; }
      return parseInt(n, 10) !== 0;
    }
    if (pos < condition.length && /[A-Za-z_]/.test(condition[pos]!)) {
      let name = '';
      while (pos < condition.length && /[A-Za-z0-9_]/.test(condition[pos]!)) { name += condition[pos]; pos++; }
      return values.get(name) ?? false;
    }
    return false;
  }

  return parseExpr();
}
