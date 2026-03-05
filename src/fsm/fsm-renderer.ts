/**
 * FSM renderer — draws states (circles) and transitions (curved arrows) using RenderContext.
 *
 * All rendering goes through the abstract RenderContext interface, never Canvas2D directly.
 * States are circles with centered name labels. Transitions are curved arrows with condition labels.
 * Initial states are drawn with a double circle. Self-loops are rendered as circular arcs above the state.
 */

import type { RenderContext, Point } from "@/core/renderer-interface";
import type { FSM, FSMState, FSMTransition } from "@/fsm/model";
import { findStateById } from "@/fsm/model";

const ARROW_SIZE = 8;
const SELF_LOOP_RADIUS = 20;
const SELF_LOOP_OFFSET_Y = -10;
const INITIAL_BORDER_GAP = 4;
const LABEL_FONT_SIZE = 12;
const NAME_FONT_SIZE = 14;

/**
 * Render the entire FSM: all states, then all transitions.
 */
export function renderFSM(
  ctx: RenderContext,
  fsm: FSM,
  selectedStateIds: ReadonlySet<string>,
  selectedTransitionIds: ReadonlySet<string>,
): void {
  for (const transition of fsm.transitions) {
    const isSelected = selectedTransitionIds.has(transition.id);
    renderTransition(ctx, fsm, transition, isSelected);
  }
  for (const state of fsm.states) {
    const isSelected = selectedStateIds.has(state.id);
    renderState(ctx, state, isSelected);
  }
}

/**
 * Render a single FSM state as a circle with its name label centered.
 * Initial states get a double circle (inner circle with a gap).
 */
export function renderState(
  ctx: RenderContext,
  state: FSMState,
  selected: boolean,
): void {
  ctx.save();

  if (selected) {
    ctx.setColor("SELECTION");
  } else {
    ctx.setColor("COMPONENT");
  }

  ctx.setLineWidth(2);
  ctx.drawCircle(state.position.x, state.position.y, state.radius, false);

  if (state.isInitial) {
    ctx.drawCircle(
      state.position.x,
      state.position.y,
      state.radius - INITIAL_BORDER_GAP,
      false,
    );
  }

  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: NAME_FONT_SIZE, weight: "bold" });
  ctx.drawText(state.name, state.position.x, state.position.y, {
    horizontal: "center",
    vertical: "middle",
  });

  const outputEntries = Object.entries(state.outputs);
  if (outputEntries.length > 0) {
    ctx.setFont({ family: "sans-serif", size: LABEL_FONT_SIZE });
    const outputText = outputEntries.map(([k, v]) => `${k}=${v}`).join(", ");
    ctx.drawText(
      outputText,
      state.position.x,
      state.position.y + state.radius + LABEL_FONT_SIZE + 2,
      { horizontal: "center", vertical: "top" },
    );
  }

  ctx.restore();
}

/**
 * Render a transition as an arrow from source to target with a condition label.
 * Self-loops are rendered as a circular arc above the state.
 */
export function renderTransition(
  ctx: RenderContext,
  fsm: FSM,
  transition: FSMTransition,
  selected: boolean,
): void {
  const source = findStateById(fsm, transition.sourceStateId);
  const target = findStateById(fsm, transition.targetStateId);
  if (source === undefined || target === undefined) return;

  ctx.save();

  if (selected) {
    ctx.setColor("SELECTION");
  } else {
    ctx.setColor("COMPONENT");
  }
  ctx.setLineWidth(1.5);

  if (transition.sourceStateId === transition.targetStateId) {
    renderSelfLoop(ctx, source, transition, selected);
  } else {
    renderDirectTransition(ctx, source, target, transition);
  }

  ctx.restore();
}

function renderDirectTransition(
  ctx: RenderContext,
  source: FSMState,
  target: FSMState,
  transition: FSMTransition,
): void {
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;

  const nx = dx / dist;
  const ny = dy / dist;

  const startX = source.position.x + nx * source.radius;
  const startY = source.position.y + ny * source.radius;
  const endX = target.position.x - nx * target.radius;
  const endY = target.position.y - ny * target.radius;

  if (transition.controlPoints.length > 0) {
    const cp = transition.controlPoints[0]!;
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: startX, y: startY },
        {
          op: "curveTo",
          cp1x: cp.x,
          cp1y: cp.y,
          cp2x: cp.x,
          cp2y: cp.y,
          x: endX,
          y: endY,
        },
      ],
    });
  } else {
    ctx.drawLine(startX, startY, endX, endY);
  }

  drawArrowHead(ctx, endX, endY, Math.atan2(dy, dy !== 0 || dx !== 0 ? dx : 1));

  const labelX = (startX + endX) / 2;
  const labelY = (startY + endY) / 2 - 8;
  if (transition.condition !== "") {
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: LABEL_FONT_SIZE });
    ctx.drawText(transition.condition, labelX, labelY, {
      horizontal: "center",
      vertical: "bottom",
    });
  }
}

/**
 * Render a self-loop as a circular arc above the state.
 */
export function renderSelfLoop(
  ctx: RenderContext,
  state: FSMState,
  transition: FSMTransition,
  selected: boolean,
): void {
  const arcCx = state.position.x;
  const arcCy = state.position.y - state.radius + SELF_LOOP_OFFSET_Y;

  ctx.drawArc(arcCx, arcCy, SELF_LOOP_RADIUS, 0.3, Math.PI * 2 - 0.3);

  const arrowAngle = Math.PI * 2 - 0.3;
  const arrowX = arcCx + Math.cos(arrowAngle) * SELF_LOOP_RADIUS;
  const arrowY = arcCy + Math.sin(arrowAngle) * SELF_LOOP_RADIUS;
  drawArrowHead(ctx, arrowX, arrowY, Math.PI / 2);

  if (transition.condition !== "") {
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: LABEL_FONT_SIZE });
    ctx.drawText(transition.condition, arcCx, arcCy - SELF_LOOP_RADIUS - 4, {
      horizontal: "center",
      vertical: "bottom",
    });
  }
}

function drawArrowHead(
  ctx: RenderContext,
  tipX: number,
  tipY: number,
  angle: number,
): void {
  const p1: Point = {
    x: tipX - ARROW_SIZE * Math.cos(angle - Math.PI / 6),
    y: tipY - ARROW_SIZE * Math.sin(angle - Math.PI / 6),
  };
  const p2: Point = {
    x: tipX - ARROW_SIZE * Math.cos(angle + Math.PI / 6),
    y: tipY - ARROW_SIZE * Math.sin(angle + Math.PI / 6),
  };
  ctx.drawPolygon([{ x: tipX, y: tipY }, p1, p2], true);
}
