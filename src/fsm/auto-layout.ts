/**
 * Auto-layout for FSM states.
 *
 * Arranges states in a circular layout centered at a given origin.
 * The radius of the layout circle scales with the number of states
 * so that states do not overlap.
 */

import type { FSM } from "@/fsm/model";

const MIN_LAYOUT_RADIUS = 80;
const SPACING_PER_STATE = 50;

/**
 * Arrange all states in a circle centered at (centerX, centerY).
 * Mutates state positions in place.
 */
export function autoLayoutCircle(
  fsm: FSM,
  centerX: number = 200,
  centerY: number = 200,
): void {
  const count = fsm.states.length;
  if (count === 0) return;

  if (count === 1) {
    fsm.states[0]!.position.x = centerX;
    fsm.states[0]!.position.y = centerY;
    return;
  }

  const layoutRadius = Math.max(MIN_LAYOUT_RADIUS, count * SPACING_PER_STATE / (2 * Math.PI) + 30);
  const angleStep = (2 * Math.PI) / count;

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + i * angleStep;
    fsm.states[i]!.position.x = centerX + layoutRadius * Math.cos(angle);
    fsm.states[i]!.position.y = centerY + layoutRadius * Math.sin(angle);
  }
}

/**
 * Arrange all states in a grid layout.
 * Mutates state positions in place.
 */
export function autoLayoutGrid(
  fsm: FSM,
  startX: number = 100,
  startY: number = 100,
  cellWidth: number = 120,
  cellHeight: number = 120,
): void {
  const count = fsm.states.length;
  if (count === 0) return;

  const cols = Math.ceil(Math.sqrt(count));

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    fsm.states[i]!.position.x = startX + col * cellWidth;
    fsm.states[i]!.position.y = startY + row * cellHeight;
  }
}
