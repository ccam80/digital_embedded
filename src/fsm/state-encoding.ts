/**
 * State encoding for FSM states.
 *
 * Assigns a unique bit pattern to each state using one of three encoding
 * schemes: binary, Gray code, or one-hot. The encoding maps state IDs to
 * bigint values that serve as the state-variable assignments in the
 * transition table.
 */

import type { FSMState } from './model.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode FSM states using the specified encoding scheme.
 *
 * @param states   The list of FSM states (order determines encoding assignment).
 * @param encoding The encoding scheme to use.
 * @returns        Map from state ID to encoded bigint value.
 */
export function encodeStates(
  states: readonly FSMState[],
  encoding: 'binary' | 'gray' | 'oneHot',
): Map<string, bigint> {
  switch (encoding) {
    case 'binary':
      return encodeBinary(states);
    case 'gray':
      return encodeGray(states);
    case 'oneHot':
      return encodeOneHot(states);
  }
}

/**
 * Compute the number of state bits needed for the given encoding.
 */
export function stateBitsRequired(
  stateCount: number,
  encoding: 'binary' | 'gray' | 'oneHot',
): number {
  if (stateCount <= 0) return 0;
  if (encoding === 'oneHot') return stateCount;
  if (stateCount === 1) return 1;
  let bits = 1;
  while ((1 << bits) < stateCount) bits++;
  return bits;
}

// ---------------------------------------------------------------------------
// Binary encoding
// ---------------------------------------------------------------------------

function encodeBinary(states: readonly FSMState[]): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (let i = 0; i < states.length; i++) {
    map.set(states[i]!.id, BigInt(i));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Gray code encoding
// ---------------------------------------------------------------------------

/**
 * Convert a binary number to its Gray code equivalent.
 */
function binaryToGray(n: number): number {
  return n ^ (n >> 1);
}

function encodeGray(states: readonly FSMState[]): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (let i = 0; i < states.length; i++) {
    map.set(states[i]!.id, BigInt(binaryToGray(i)));
  }
  return map;
}

// ---------------------------------------------------------------------------
// One-hot encoding
// ---------------------------------------------------------------------------

function encodeOneHot(states: readonly FSMState[]): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (let i = 0; i < states.length; i++) {
    map.set(states[i]!.id, 1n << BigInt(i));
  }
  return map;
}
