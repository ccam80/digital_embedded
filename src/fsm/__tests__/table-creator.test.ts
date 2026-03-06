import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFSM,
  addState,
  addTransition,
  resetIdCounter,
} from '../model.js';
import { fsmToTransitionTable } from '../table-creator.js';
import { encodeStates, stateBitsRequired } from '../state-encoding.js';

beforeEach(() => {
  resetIdCounter();
});

describe('fsmToTransitionTable', () => {
  it('simpleToggle', () => {
    // 2-state FSM with toggle on input A
    // S0 --A--> S1, S1 --A--> S0
    const fsm = createFSM('toggle');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s1.id, s0.id, 'A');

    const table = fsmToTransitionTable(fsm);

    // 2 states, binary encoding -> 1 state bit
    expect(table.stateVars).toHaveLength(1);
    expect(table.stateVars[0]!.name).toBe('Z_0');

    // 1 input signal
    expect(table.inputs).toHaveLength(1);
    expect(table.inputs[0]!.name).toBe('A');

    // 1 output signal
    expect(table.outputs).toHaveLength(1);
    expect(table.outputs[0]!.name).toBe('Y');

    // 2 states x 2 input values = 4 transitions
    expect(table.transitions).toHaveLength(4);

    // S0 (encoding=0), A=0 -> stays S0 (no matching transition)
    const t00 = table.transitions.find(
      (t) => t.currentState[0] === 0n && t.input[0] === 0n,
    )!;
    expect(t00.nextState[0]).toBe(0n);
    expect(t00.output[0]).toBe(0n); // S0's Moore output Y=0

    // S0 (encoding=0), A=1 -> goes to S1 (encoding=1)
    const t01 = table.transitions.find(
      (t) => t.currentState[0] === 0n && t.input[0] === 1n,
    )!;
    expect(t01.nextState[0]).toBe(1n);

    // S1 (encoding=1), A=0 -> stays S1
    const t10 = table.transitions.find(
      (t) => t.currentState[0] === 1n && t.input[0] === 0n,
    )!;
    expect(t10.nextState[0]).toBe(1n);
    expect(t10.output[0]).toBe(1n); // S1's Moore output Y=1

    // S1 (encoding=1), A=1 -> goes to S0
    const t11 = table.transitions.find(
      (t) => t.currentState[0] === 1n && t.input[0] === 1n,
    )!;
    expect(t11.nextState[0]).toBe(0n);
  });

  it('binaryEncoding', () => {
    // 4 states, binary encoding -> state bits = 2
    const fsm = createFSM('counter');
    fsm.stateEncoding = 'binary';
    fsm.inputSignals = [];
    fsm.outputSignals = [];

    addState(fsm, 'S0', { x: 0, y: 0 });
    addState(fsm, 'S1', { x: 100, y: 0 });
    addState(fsm, 'S2', { x: 0, y: 100 });
    addState(fsm, 'S3', { x: 100, y: 100 });

    const table = fsmToTransitionTable(fsm);
    expect(table.stateVars).toHaveLength(2);
    expect(table.stateVars[0]!.name).toBe('Z_1');
    expect(table.stateVars[1]!.name).toBe('Z_0');

    const numStateBits = stateBitsRequired(4, 'binary');
    expect(numStateBits).toBe(2);

    const stateMap = encodeStates(fsm.states, 'binary');
    expect(stateMap.get(fsm.states[0]!.id)).toBe(0n);
    expect(stateMap.get(fsm.states[1]!.id)).toBe(1n);
    expect(stateMap.get(fsm.states[2]!.id)).toBe(2n);
    expect(stateMap.get(fsm.states[3]!.id)).toBe(3n);
  });

  it('grayEncoding', () => {
    // 4 states, Gray encoding -> verify Gray code assignments
    const fsm = createFSM('gray');
    fsm.stateEncoding = 'gray';
    fsm.inputSignals = [];
    fsm.outputSignals = [];

    addState(fsm, 'S0', { x: 0, y: 0 });
    addState(fsm, 'S1', { x: 100, y: 0 });
    addState(fsm, 'S2', { x: 0, y: 100 });
    addState(fsm, 'S3', { x: 100, y: 100 });

    const stateMap = encodeStates(fsm.states, 'gray');

    // Gray code: 0->00, 1->01, 2->11, 3->10
    expect(stateMap.get(fsm.states[0]!.id)).toBe(0n); // 00
    expect(stateMap.get(fsm.states[1]!.id)).toBe(1n); // 01
    expect(stateMap.get(fsm.states[2]!.id)).toBe(3n); // 11
    expect(stateMap.get(fsm.states[3]!.id)).toBe(2n); // 10

    // Adjacent states differ by exactly one bit
    const values = [...stateMap.values()];
    for (let i = 0; i < values.length - 1; i++) {
      const xor = values[i]! ^ values[i + 1]!;
      // xor should be a power of 2 (exactly one bit differs)
      expect(xor & (xor - 1n)).toBe(0n);
      expect(xor).not.toBe(0n);
    }
  });

  it('oneHotEncoding', () => {
    // 4 states, one-hot -> state bits = 4, one bit per state
    const fsm = createFSM('onehot');
    fsm.stateEncoding = 'oneHot';
    fsm.inputSignals = [];
    fsm.outputSignals = [];

    addState(fsm, 'S0', { x: 0, y: 0 });
    addState(fsm, 'S1', { x: 100, y: 0 });
    addState(fsm, 'S2', { x: 0, y: 100 });
    addState(fsm, 'S3', { x: 100, y: 100 });

    const numStateBits = stateBitsRequired(4, 'oneHot');
    expect(numStateBits).toBe(4);

    const stateMap = encodeStates(fsm.states, 'oneHot');
    expect(stateMap.get(fsm.states[0]!.id)).toBe(0b0001n);
    expect(stateMap.get(fsm.states[1]!.id)).toBe(0b0010n);
    expect(stateMap.get(fsm.states[2]!.id)).toBe(0b0100n);
    expect(stateMap.get(fsm.states[3]!.id)).toBe(0b1000n);

    // Each encoding has exactly one bit set
    for (const val of stateMap.values()) {
      expect(val & (val - 1n)).toBe(0n);
      expect(val).not.toBe(0n);
    }
  });

  it('defaultTransition', () => {
    // State with no matching transition for an input stays in same state
    const fsm = createFSM('default');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 1 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 0 } });

    // Only transition: S0 -> S1 when A=1. No transition when A=0.
    addTransition(fsm, s0.id, s1.id, 'A');

    const table = fsmToTransitionTable(fsm);

    // S0 (0), A=0: no matching transition -> stays S0
    const t00 = table.transitions.find(
      (t) => t.currentState[0] === 0n && t.input[0] === 0n,
    )!;
    expect(t00.nextState[0]).toBe(0n);
    expect(t00.output[0]).toBe(1n); // S0 Moore output

    // S0 (0), A=1: transition to S1
    const t01 = table.transitions.find(
      (t) => t.currentState[0] === 0n && t.input[0] === 1n,
    )!;
    expect(t01.nextState[0]).toBe(1n);

    // S1 (1), A=0: no transition -> stays S1
    const t10 = table.transitions.find(
      (t) => t.currentState[0] === 1n && t.input[0] === 0n,
    )!;
    expect(t10.nextState[0]).toBe(1n);

    // S1 (1), A=1: no transition -> stays S1
    const t11 = table.transitions.find(
      (t) => t.currentState[0] === 1n && t.input[0] === 1n,
    )!;
    expect(t11.nextState[0]).toBe(1n);
  });

  it('mooreOutputs', () => {
    // Moore outputs appear in correct columns
    const fsm = createFSM('moore');
    fsm.inputSignals = ['CLK'];
    fsm.outputSignals = ['X', 'Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { X: 1, Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { X: 0, Y: 1 } });

    addTransition(fsm, s0.id, s1.id, 'CLK');
    addTransition(fsm, s1.id, s0.id, 'CLK');

    const table = fsmToTransitionTable(fsm);

    expect(table.outputs).toHaveLength(2);
    expect(table.outputs[0]!.name).toBe('X');
    expect(table.outputs[1]!.name).toBe('Y');

    // S0 state: X=1, Y=0
    const s0Rows = table.transitions.filter((t) => t.currentState[0] === 0n);
    for (const row of s0Rows) {
      expect(row.output[0]).toBe(1n); // X=1
      expect(row.output[1]).toBe(0n); // Y=0
    }

    // S1 state: X=0, Y=1
    const s1Rows = table.transitions.filter((t) => t.currentState[0] === 1n);
    for (const row of s1Rows) {
      expect(row.output[0]).toBe(0n); // X=0
      expect(row.output[1]).toBe(1n); // Y=1
    }
  });
});
