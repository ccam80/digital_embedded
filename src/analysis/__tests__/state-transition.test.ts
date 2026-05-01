/**
 * Tests for state transition table analysis.
 */

import { describe, it, expect } from 'vitest';
import { analyseSequential } from '../state-transition.js';
import type { SequentialAnalysisFacade, SignalSpec } from '../state-transition.js';

// ---------------------------------------------------------------------------
// Mock facade
// ---------------------------------------------------------------------------

class MockFacade implements SequentialAnalysisFacade {
  private _state = new Map<string, bigint>();
  private _inputs = new Map<string, bigint>();
  private _nextStateFn: (state: Map<string, bigint>, inputs: Map<string, bigint>) => Map<string, bigint>;
  private _outputFn: (state: Map<string, bigint>, inputs: Map<string, bigint>) => Map<string, bigint>;

  constructor(
    nextStateFn: (s: Map<string, bigint>, i: Map<string, bigint>) => Map<string, bigint>,
    outputFn: (s: Map<string, bigint>, i: Map<string, bigint>) => Map<string, bigint>,
  ) {
    this._nextStateFn = nextStateFn;
    this._outputFn = outputFn;
  }

  setStateValue(name: string, value: bigint): void {
    this._state.set(name, value);
  }

  setInput(name: string, value: bigint): void {
    this._inputs.set(name, value);
  }

  clockStep(): void {
    const nextState = this._nextStateFn(this._state, this._inputs);
    const outputs = this._outputFn(this._state, this._inputs);
    // Apply next state (so getStateValue returns next state after clock)
    for (const [k, v] of nextState) {
      this._state.set(k, v);
    }
    // Store outputs for reading
    this._outputs = outputs;
  }

  private _outputs = new Map<string, bigint>();

  getStateValue(name: string): bigint {
    return this._state.get(name) ?? 0n;
  }

  getOutput(name: string): bigint {
    return this._outputs.get(name) ?? 0n;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateTransitionTable', () => {
  it('dFlipflop- D flip-flop: Q_next = D', () => {
    const facade = new MockFacade(
      (_state, inputs) => new Map([['Q', inputs.get('D') ?? 0n]]),
      (state, _inputs) => new Map([['Q_out', state.get('Q') ?? 0n]]),
    );

    const stateVars: SignalSpec[] = [{ name: 'Q', bitWidth: 1 }];
    const inputs: SignalSpec[] = [{ name: 'D', bitWidth: 1 }];
    const outputs: SignalSpec[] = [{ name: 'Q_out', bitWidth: 1 }];

    const result = analyseSequential(facade, stateVars, inputs, outputs);

    expect(result.transitions).toHaveLength(4); // 2 states × 2 inputs

    // Q=0, D=0 → Q_next=0
    expect(result.transitions[0]!.currentState).toEqual([0n]);
    expect(result.transitions[0]!.input).toEqual([0n]);
    expect(result.transitions[0]!.nextState).toEqual([0n]);

    // Q=0, D=1 → Q_next=1
    expect(result.transitions[1]!.currentState).toEqual([0n]);
    expect(result.transitions[1]!.input).toEqual([1n]);
    expect(result.transitions[1]!.nextState).toEqual([1n]);

    // Q=1, D=0 → Q_next=0
    expect(result.transitions[2]!.currentState).toEqual([1n]);
    expect(result.transitions[2]!.input).toEqual([0n]);
    expect(result.transitions[2]!.nextState).toEqual([0n]);

    // Q=1, D=1 → Q_next=1
    expect(result.transitions[3]!.currentState).toEqual([1n]);
    expect(result.transitions[3]!.input).toEqual([1n]);
    expect(result.transitions[3]!.nextState).toEqual([1n]);
  });

  it('srLatch- SR latch transitions', () => {
    const facade = new MockFacade(
      (state, inputs) => {
        const s = inputs.get('S') ?? 0n;
        const r = inputs.get('R') ?? 0n;
        const q = state.get('Q') ?? 0n;
        // SR latch: S=1,R=0 → Q=1; S=0,R=1 → Q=0; S=0,R=0 → hold; S=1,R=1 → invalid (0)
        if (s === 1n && r === 0n) return new Map([['Q', 1n]]);
        if (s === 0n && r === 1n) return new Map([['Q', 0n]]);
        if (s === 1n && r === 1n) return new Map([['Q', 0n]]); // invalid
        return new Map([['Q', q]]); // hold
      },
      (state) => new Map([['Q_out', state.get('Q') ?? 0n]]),
    );

    const stateVars: SignalSpec[] = [{ name: 'Q', bitWidth: 1 }];
    const inputs: SignalSpec[] = [{ name: 'S', bitWidth: 1 }, { name: 'R', bitWidth: 1 }];
    const outputs: SignalSpec[] = [{ name: 'Q_out', bitWidth: 1 }];

    const result = analyseSequential(facade, stateVars, inputs, outputs);

    // 2 states × 4 input combos = 8 transitions
    expect(result.transitions).toHaveLength(8);
  });

  it('twoStateBits- 2 flip-flops give 4 states', () => {
    const facade = new MockFacade(
      (state, inputs) => {
        const d = inputs.get('D') ?? 0n;
        return new Map([
          ['Q0', d],
          ['Q1', state.get('Q0') ?? 0n],
        ]);
      },
      () => new Map(),
    );

    const stateVars: SignalSpec[] = [
      { name: 'Q0', bitWidth: 1 },
      { name: 'Q1', bitWidth: 1 },
    ];
    const inputs: SignalSpec[] = [{ name: 'D', bitWidth: 1 }];
    const outputs: SignalSpec[] = [];

    const result = analyseSequential(facade, stateVars, inputs, outputs);

    // 4 states × 2 inputs = 8 transitions
    expect(result.transitions).toHaveLength(8);
  });

  it('noCombinationalOnly- throws when no state variables', () => {
    const facade = new MockFacade(
      () => new Map(),
      () => new Map(),
    );

    expect(() =>
      analyseSequential(facade, [], [{ name: 'A', bitWidth: 1 }], [{ name: 'Y', bitWidth: 1 }]),
    ).toThrow(/no state variables/i);
  });
});
