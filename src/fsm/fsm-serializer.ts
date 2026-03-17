/**
 * FSM serialization for embedding in .dts documents.
 *
 * `serializeFSM` converts an FSM model to a plain JSON-compatible object.
 * `deserializeFSM` reconstructs an FSM from that object.
 */

import type { FSM, FSMState, FSMTransition } from './model';

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize an FSM to a plain JSON-compatible object for .dts embedding. */
export function serializeFSM(fsm: FSM): object {
  return {
    name: fsm.name,
    states: fsm.states.map((s) => serializeState(s)),
    transitions: fsm.transitions.map((t) => serializeTransition(t)),
    inputSignals: [...fsm.inputSignals],
    outputSignals: [...fsm.outputSignals],
    stateEncoding: fsm.stateEncoding,
    ...(fsm.stateBits !== undefined ? { stateBits: fsm.stateBits } : {}),
  };
}

function serializeState(s: FSMState): object {
  return {
    id: s.id,
    name: s.name,
    position: { x: s.position.x, y: s.position.y },
    outputs: { ...s.outputs },
    isInitial: s.isInitial,
    radius: s.radius,
  };
}

function serializeTransition(t: FSMTransition): object {
  return {
    id: t.id,
    sourceStateId: t.sourceStateId,
    targetStateId: t.targetStateId,
    condition: t.condition,
    ...(t.actions !== undefined ? { actions: { ...t.actions } } : {}),
    controlPoints: t.controlPoints.map((cp) => ({ x: cp.x, y: cp.y })),
  };
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

/** Deserialize an FSM from a plain object (as stored in .dts). */
export function deserializeFSM(data: unknown): FSM {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid FSM data: expected an object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj['name'] !== 'string') {
    throw new Error('Invalid FSM data: "name" must be a string');
  }
  if (!Array.isArray(obj['states'])) {
    throw new Error('Invalid FSM data: "states" must be an array');
  }
  if (!Array.isArray(obj['transitions'])) {
    throw new Error('Invalid FSM data: "transitions" must be an array');
  }
  if (!Array.isArray(obj['inputSignals'])) {
    throw new Error('Invalid FSM data: "inputSignals" must be an array');
  }
  if (!Array.isArray(obj['outputSignals'])) {
    throw new Error('Invalid FSM data: "outputSignals" must be an array');
  }

  const validEncodings = ['binary', 'gray', 'oneHot'];
  if (
    typeof obj['stateEncoding'] !== 'string' ||
    !validEncodings.includes(obj['stateEncoding'])
  ) {
    throw new Error(
      'Invalid FSM data: "stateEncoding" must be "binary", "gray", or "oneHot"',
    );
  }

  const fsm: FSM = {
    name: obj['name'] as string,
    states: (obj['states'] as unknown[]).map((s, i) =>
      deserializeState(s, i),
    ),
    transitions: (obj['transitions'] as unknown[]).map((t, i) =>
      deserializeTransition(t, i),
    ),
    inputSignals: (obj['inputSignals'] as unknown[]).map((v) => String(v)),
    outputSignals: (obj['outputSignals'] as unknown[]).map((v) => String(v)),
    stateEncoding: obj['stateEncoding'] as FSM['stateEncoding'],
  };

  if (obj['stateBits'] !== undefined) {
    if (typeof obj['stateBits'] !== 'number') {
      throw new Error('Invalid FSM data: "stateBits" must be a number');
    }
    fsm.stateBits = obj['stateBits'] as number;
  }

  return fsm;
}

function deserializeState(data: unknown, index: number): FSMState {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid FSM state at index ${index}: expected an object`);
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj['id'] !== 'string') {
    throw new Error(`Invalid FSM state at index ${index}: "id" must be a string`);
  }
  if (typeof obj['name'] !== 'string') {
    throw new Error(
      `Invalid FSM state at index ${index}: "name" must be a string`,
    );
  }

  const pos = obj['position'] as Record<string, unknown> | undefined;
  if (
    pos === undefined ||
    pos === null ||
    typeof pos !== 'object' ||
    typeof pos['x'] !== 'number' ||
    typeof pos['y'] !== 'number'
  ) {
    throw new Error(
      `Invalid FSM state at index ${index}: "position" must have numeric x and y`,
    );
  }

  if (
    obj['outputs'] === null ||
    typeof obj['outputs'] !== 'object' ||
    Array.isArray(obj['outputs'])
  ) {
    throw new Error(
      `Invalid FSM state at index ${index}: "outputs" must be an object`,
    );
  }

  if (typeof obj['isInitial'] !== 'boolean') {
    throw new Error(
      `Invalid FSM state at index ${index}: "isInitial" must be a boolean`,
    );
  }

  if (typeof obj['radius'] !== 'number') {
    throw new Error(
      `Invalid FSM state at index ${index}: "radius" must be a number`,
    );
  }

  const outputs: Record<string, number> = {};
  for (const [k, v] of Object.entries(
    obj['outputs'] as Record<string, unknown>,
  )) {
    outputs[k] = Number(v);
  }

  return {
    id: obj['id'] as string,
    name: obj['name'] as string,
    position: { x: pos['x'] as number, y: pos['y'] as number },
    outputs,
    isInitial: obj['isInitial'] as boolean,
    radius: obj['radius'] as number,
  };
}

function deserializeTransition(data: unknown, index: number): FSMTransition {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      `Invalid FSM transition at index ${index}: expected an object`,
    );
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj['id'] !== 'string') {
    throw new Error(
      `Invalid FSM transition at index ${index}: "id" must be a string`,
    );
  }
  if (typeof obj['sourceStateId'] !== 'string') {
    throw new Error(
      `Invalid FSM transition at index ${index}: "sourceStateId" must be a string`,
    );
  }
  if (typeof obj['targetStateId'] !== 'string') {
    throw new Error(
      `Invalid FSM transition at index ${index}: "targetStateId" must be a string`,
    );
  }
  if (typeof obj['condition'] !== 'string') {
    throw new Error(
      `Invalid FSM transition at index ${index}: "condition" must be a string`,
    );
  }
  if (!Array.isArray(obj['controlPoints'])) {
    throw new Error(
      `Invalid FSM transition at index ${index}: "controlPoints" must be an array`,
    );
  }

  let actions: Record<string, number> | undefined;
  if (obj['actions'] !== undefined) {
    if (
      obj['actions'] === null ||
      typeof obj['actions'] !== 'object' ||
      Array.isArray(obj['actions'])
    ) {
      throw new Error(
        `Invalid FSM transition at index ${index}: "actions" must be an object`,
      );
    }
    actions = {};
    for (const [k, v] of Object.entries(
      obj['actions'] as Record<string, unknown>,
    )) {
      actions[k] = Number(v);
    }
  }

  const controlPoints = (obj['controlPoints'] as unknown[]).map(
    (cp: unknown) => {
      const p = cp as Record<string, unknown>;
      return { x: Number(p['x']), y: Number(p['y']) };
    },
  );

  return {
    id: obj['id'] as string,
    sourceStateId: obj['sourceStateId'] as string,
    targetStateId: obj['targetStateId'] as string,
    condition: obj['condition'] as string,
    actions,
    controlPoints,
  };
}
