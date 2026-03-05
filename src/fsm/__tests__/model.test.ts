import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFSM,
  addState,
  addTransition,
  removeState,
  removeTransition,
  validateFSM,
  resetIdCounter,
} from '../model';
import { serializeFSM, deserializeFSM } from '../fsm-serializer';
import { importDigitalFSM, resetImportIdCounter } from '../fsm-import';

beforeEach(() => {
  resetIdCounter();
});

// ---------------------------------------------------------------------------
// createFSM
// ---------------------------------------------------------------------------

describe('createFSM', () => {
  it('creates FSM with 2 states and 1 transition, verify structure', () => {
    const fsm = createFSM('test');
    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });
    const t = addTransition(fsm, s0.id, s1.id, 'A=1');

    expect(fsm.name).toBe('test');
    expect(fsm.states).toHaveLength(2);
    expect(fsm.transitions).toHaveLength(1);
    expect(fsm.stateEncoding).toBe('binary');
    expect(fsm.inputSignals).toEqual([]);
    expect(fsm.outputSignals).toEqual([]);

    expect(fsm.states[0].id).toBe(s0.id);
    expect(fsm.states[0].name).toBe('S0');
    expect(fsm.states[0].position).toEqual({ x: 0, y: 0 });
    expect(fsm.states[0].isInitial).toBe(true);
    expect(fsm.states[0].radius).toBe(30);

    expect(fsm.states[1].id).toBe(s1.id);
    expect(fsm.states[1].name).toBe('S1');
    expect(fsm.states[1].isInitial).toBe(false);

    expect(t.sourceStateId).toBe(s0.id);
    expect(t.targetStateId).toBe(s1.id);
    expect(t.condition).toBe('A=1');
    expect(t.controlPoints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// addRemoveState
// ---------------------------------------------------------------------------

describe('addRemoveState', () => {
  it('adds state and verifies present; removes state and verifies absent with connected transitions removed', () => {
    const fsm = createFSM('test');
    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });
    const s2 = addState(fsm, 'S2', { x: 200, y: 0 });

    addTransition(fsm, s0.id, s1.id, 'A=1');
    addTransition(fsm, s1.id, s2.id, 'B=1');
    addTransition(fsm, s0.id, s2.id, 'C=1');

    expect(fsm.states).toHaveLength(3);
    expect(fsm.transitions).toHaveLength(3);
    expect(fsm.states.some((s) => s.id === s1.id)).toBe(true);

    removeState(fsm, s1.id);

    expect(fsm.states).toHaveLength(2);
    expect(fsm.states.some((s) => s.id === s1.id)).toBe(false);
    expect(fsm.transitions).toHaveLength(1);
    expect(fsm.transitions[0].sourceStateId).toBe(s0.id);
    expect(fsm.transitions[0].targetStateId).toBe(s2.id);
  });
});

// ---------------------------------------------------------------------------
// addRemoveTransition
// ---------------------------------------------------------------------------

describe('addRemoveTransition', () => {
  it('adds transition between states and verifies present; removes and verifies absent', () => {
    const fsm = createFSM('test');
    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });

    const t = addTransition(fsm, s0.id, s1.id, 'X=1');
    expect(fsm.transitions).toHaveLength(1);
    expect(fsm.transitions[0].id).toBe(t.id);

    removeTransition(fsm, t.id);
    expect(fsm.transitions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateReachability
// ---------------------------------------------------------------------------

describe('validateReachability', () => {
  it('warns when state is not reachable from initial', () => {
    const fsm = createFSM('test');
    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    addState(fsm, 'S1', { x: 100, y: 0 });
    const s2 = addState(fsm, 'S2', { x: 200, y: 0 });

    addTransition(fsm, s0.id, s2.id, 'A=1');

    const issues = validateFSM(fsm);
    const reachWarnings = issues.filter(
      (i) => i.severity === 'warning' && i.message.includes('not reachable'),
    );
    expect(reachWarnings).toHaveLength(1);
    expect(reachWarnings[0].message).toContain('S1');
  });
});

// ---------------------------------------------------------------------------
// validateDuplicateNames
// ---------------------------------------------------------------------------

describe('validateDuplicateNames', () => {
  it('errors when two states have the same name', () => {
    const fsm = createFSM('test');
    addState(fsm, 'SAME', { x: 0, y: 0 });
    addState(fsm, 'SAME', { x: 100, y: 0 });

    const issues = validateFSM(fsm);
    const dupErrors = issues.filter(
      (i) => i.severity === 'error' && i.message.includes('Duplicate state name'),
    );
    expect(dupErrors).toHaveLength(1);
    expect(dupErrors[0].message).toContain('SAME');
  });
});

// ---------------------------------------------------------------------------
// validateConditionSyntax
// ---------------------------------------------------------------------------

describe('validateConditionSyntax', () => {
  it('errors on transition with invalid condition expression', () => {
    const fsm = createFSM('test');
    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });

    addTransition(fsm, s0.id, s1.id, '&& invalid');

    const issues = validateFSM(fsm);
    const condErrors = issues.filter(
      (i) => i.severity === 'error' && i.message.includes('Invalid condition'),
    );
    expect(condErrors).toHaveLength(1);
  });

  it('accepts valid condition expressions', () => {
    const fsm = createFSM('test');
    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });

    addTransition(fsm, s0.id, s1.id, 'A=1 & !B');
    addTransition(fsm, s0.id, s1.id, '(X | Y) & Z=0');
    addTransition(fsm, s0.id, s1.id, '');

    const issues = validateFSM(fsm);
    const condErrors = issues.filter(
      (i) => i.severity === 'error' && i.message.includes('Invalid condition'),
    );
    expect(condErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// serializeRoundTrip
// ---------------------------------------------------------------------------

describe('serializeRoundTrip', () => {
  it('serializes FSM, deserializes, and verifies identical', () => {
    const fsm = createFSM('roundtrip');
    fsm.inputSignals = ['A', 'B'];
    fsm.outputSignals = ['Y'];
    fsm.stateEncoding = 'gray';

    const s0 = addState(fsm, 'IDLE', { x: 10, y: 20 }, {
      outputs: { Y: 0 },
      isInitial: true,
    });
    const s1 = addState(fsm, 'ACTIVE', { x: 100, y: 200 }, {
      outputs: { Y: 1 },
      radius: 40,
    });

    addTransition(fsm, s0.id, s1.id, 'A=1 & B=0', {
      actions: { Y: 1 },
      controlPoints: [{ x: 50, y: 50 }],
    });
    addTransition(fsm, s1.id, s0.id, '!A');

    const serialized = serializeFSM(fsm);
    const restored = deserializeFSM(serialized);

    expect(restored.name).toBe(fsm.name);
    expect(restored.inputSignals).toEqual(fsm.inputSignals);
    expect(restored.outputSignals).toEqual(fsm.outputSignals);
    expect(restored.stateEncoding).toBe(fsm.stateEncoding);
    expect(restored.stateBits).toBeUndefined();

    expect(restored.states).toHaveLength(2);
    expect(restored.states[0].id).toBe(s0.id);
    expect(restored.states[0].name).toBe('IDLE');
    expect(restored.states[0].position).toEqual({ x: 10, y: 20 });
    expect(restored.states[0].outputs).toEqual({ Y: 0 });
    expect(restored.states[0].isInitial).toBe(true);
    expect(restored.states[0].radius).toBe(30);

    expect(restored.states[1].id).toBe(s1.id);
    expect(restored.states[1].name).toBe('ACTIVE');
    expect(restored.states[1].position).toEqual({ x: 100, y: 200 });
    expect(restored.states[1].outputs).toEqual({ Y: 1 });
    expect(restored.states[1].isInitial).toBe(false);
    expect(restored.states[1].radius).toBe(40);

    expect(restored.transitions).toHaveLength(2);
    expect(restored.transitions[0].sourceStateId).toBe(s0.id);
    expect(restored.transitions[0].targetStateId).toBe(s1.id);
    expect(restored.transitions[0].condition).toBe('A=1 & B=0');
    expect(restored.transitions[0].actions).toEqual({ Y: 1 });
    expect(restored.transitions[0].controlPoints).toEqual([{ x: 50, y: 50 }]);

    expect(restored.transitions[1].sourceStateId).toBe(s1.id);
    expect(restored.transitions[1].targetStateId).toBe(s0.id);
    expect(restored.transitions[1].condition).toBe('!A');
    expect(restored.transitions[1].actions).toBeUndefined();
    expect(restored.transitions[1].controlPoints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// importFsmFile
// ---------------------------------------------------------------------------

describe('importFsmFile', () => {
  beforeEach(() => {
    resetImportIdCounter();
  });

  it('imports Digital .fsm XML and verifies states and transitions match', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<fsm>
  <states>
    <state>
      <values>Y=0</values>
      <position x="0.0" y="-100.0"/>
      <number>0</number>
      <name>IDLE</name>
      <radius>70</radius>
      <isInitial>true</isInitial>
      <initialAngle>12</initialAngle>
    </state>
    <state>
      <values>Y=1</values>
      <position x="200.0" y="100.0"/>
      <number>1</number>
      <name>ACTIVE</name>
      <radius>70</radius>
      <isInitial>false</isInitial>
      <initialAngle>0</initialAngle>
    </state>
  </states>
  <transitions>
    <transition>
      <values>ov=1</values>
      <position x="100.0" y="0.0"/>
      <fromState reference="../../../states/state"/>
      <toState reference="../../../states/state[2]"/>
      <condition>A=1 &amp; B=0</condition>
    </transition>
    <transition>
      <values></values>
      <position x="100.0" y="50.0"/>
      <fromState reference="../../../states/state[2]"/>
      <toState reference="../../../states/state"/>
      <condition>A=0</condition>
    </transition>
  </transitions>
</fsm>`;

    const fsm = importDigitalFSM(xml);

    expect(fsm.states).toHaveLength(2);
    expect(fsm.states[0].name).toBe('IDLE');
    expect(fsm.states[0].position).toEqual({ x: 0, y: -100 });
    expect(fsm.states[0].outputs).toEqual({ Y: 0 });
    expect(fsm.states[0].isInitial).toBe(true);
    expect(fsm.states[0].radius).toBe(70);

    expect(fsm.states[1].name).toBe('ACTIVE');
    expect(fsm.states[1].position).toEqual({ x: 200, y: 100 });
    expect(fsm.states[1].outputs).toEqual({ Y: 1 });
    expect(fsm.states[1].isInitial).toBe(false);

    expect(fsm.transitions).toHaveLength(2);

    expect(fsm.transitions[0].sourceStateId).toBe(fsm.states[0].id);
    expect(fsm.transitions[0].targetStateId).toBe(fsm.states[1].id);
    expect(fsm.transitions[0].condition).toBe('A=1 & B=0');
    expect(fsm.transitions[0].actions).toEqual({ ov: 1 });
    expect(fsm.transitions[0].controlPoints).toEqual([{ x: 100, y: 0 }]);

    expect(fsm.transitions[1].sourceStateId).toBe(fsm.states[1].id);
    expect(fsm.transitions[1].targetStateId).toBe(fsm.states[0].id);
    expect(fsm.transitions[1].condition).toBe('A=0');
    expect(fsm.transitions[1].actions).toBeUndefined();

    expect(fsm.inputSignals).toContain('A');
    expect(fsm.inputSignals).toContain('B');
    expect(fsm.outputSignals).toContain('Y');
    expect(fsm.outputSignals).toContain('ov');
  });
});
