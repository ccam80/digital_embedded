/**
 * FSM hit testing- determine which state or transition the user clicked.
 *
 * States use point-in-circle tests. Transitions use point-near-curve distance.
 * Priority: state > transition > none (states are rendered on top of transitions).
 */

import type { FSM, FSMState, FSMTransition } from "@/fsm/model";
import { findStateById } from "@/fsm/model";

export type FSMHitResult =
  | { type: "state"; state: FSMState }
  | { type: "transition"; transition: FSMTransition }
  | { type: "none" };

/**
 * Hit test a point against all FSM states and transitions.
 * States take priority over transitions.
 */
export function hitTestFSM(
  fsm: FSM,
  x: number,
  y: number,
  threshold: number = 8,
): FSMHitResult {
  const stateHit = hitTestStates(fsm.states, x, y);
  if (stateHit !== undefined) {
    return { type: "state", state: stateHit };
  }

  const transitionHit = hitTestTransitions(fsm, x, y, threshold);
  if (transitionHit !== undefined) {
    return { type: "transition", transition: transitionHit };
  }

  return { type: "none" };
}

/**
 * Find the first state whose circle contains the given point.
 */
export function hitTestStates(
  states: readonly FSMState[],
  x: number,
  y: number,
): FSMState | undefined {
  for (let i = states.length - 1; i >= 0; i--) {
    const state = states[i]!;
    const dx = x - state.position.x;
    const dy = y - state.position.y;
    if (dx * dx + dy * dy <= state.radius * state.radius) {
      return state;
    }
  }
  return undefined;
}

/**
 * Find the first transition whose line/curve is within threshold distance of the point.
 */
export function hitTestTransitions(
  fsm: FSM,
  x: number,
  y: number,
  threshold: number,
): FSMTransition | undefined {
  for (let i = fsm.transitions.length - 1; i >= 0; i--) {
    const t = fsm.transitions[i]!;
    const source = findStateById(fsm, t.sourceStateId);
    const target = findStateById(fsm, t.targetStateId);
    if (source === undefined || target === undefined) continue;

    if (t.sourceStateId === t.targetStateId) {
      const arcCx = source.position.x;
      const arcCy = source.position.y - source.radius - 10;
      const arcRadius = 20;
      const dx = x - arcCx;
      const dy = y - arcCy;
      const distFromCenter = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(distFromCenter - arcRadius) <= threshold) {
        return t;
      }
    } else {
      const dist = distanceToLineSegment(
        x,
        y,
        source.position.x,
        source.position.y,
        target.position.x,
        target.position.y,
      );
      if (dist <= threshold) {
        return t;
      }
    }
  }
  return undefined;
}

function distanceToLineSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  const fx = px - closestX;
  const fy = py - closestY;
  return Math.sqrt(fx * fx + fy * fy);
}
