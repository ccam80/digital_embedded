/**
 * ElementRenderer — iterates circuit elements and dispatches draw calls.
 *
 * Applies position, rotation, and mirror transforms per element, then
 * delegates to element.draw(ctx). Also draws pin indicators, negation
 * bubbles, clock triangles, and selection highlights.
 */

import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import { pinWorldPosition, rotatePoint } from "@/core/pin";
import { worldBoundingBox } from "./hit-test.js";

/** Radius of the filled circle drawn at each pin position (grid units). */
const PIN_CIRCLE_RADIUS = 0.15;

/**
 * Radius of the unfilled negation bubble (grid units).
 * Java: drawCircle from (pinX+2, pinY-SIZE2+2) to (pinX+SIZE-2, pinY+SIZE2-2)
 * → diameter = SIZE-4 = 16px = 0.8 grid → radius = 0.4 grid.
 */
const NEGATION_BUBBLE_RADIUS = 0.4;

/** Half-size of the clock triangle indicator (grid units). */
const CLOCK_TRIANGLE_HALF = 0.2;

/**
 * Returns true if the element's bounding box intersects the given viewport rect.
 * Both are in world (grid) coordinates.
 */
function isVisible(element: CircuitElement, viewport: Rect): boolean {
  const bb = worldBoundingBox(element);
  return (
    bb.x < viewport.x + viewport.width &&
    bb.x + bb.width > viewport.x &&
    bb.y < viewport.y + viewport.height &&
    bb.y + bb.height > viewport.y
  );
}

export class ElementRenderer {
  /**
   * Render all visible elements in the circuit.
   *
   * For each element whose bounding box intersects the viewport:
   *   - save context state
   *   - translate to element world position
   *   - apply rotation (in radians) and mirror scale transforms
   *   - call element.draw(ctx)
   *   - draw pin indicators
   *   - draw selection highlight if element is in the selection set
   *   - restore context state
   */
  render(
    ctx: RenderContext,
    circuit: Circuit,
    selection: ReadonlySet<CircuitElement>,
    viewport: Rect,
  ): void {
    // Build set of elements that overlap another element at the same position
    const overlapSet = this._findOverlaps(circuit.elements);

    for (const element of circuit.elements) {
      if (!isVisible(element, viewport)) {
        continue;
      }

      ctx.save();
      ctx.translate(element.position.x, element.position.y);

      if (element.rotation !== 0) {
        // Negate the angle: rotatePoint uses (x,y)→(y,-x) for rot=1,
        // which corresponds to rotate(-PI/2) in Canvas2D coordinates.
        ctx.rotate(-(element.rotation * Math.PI) / 2);
      }
      if (element.mirror) {
        // Mirror negates Y in local space, matching Java Digital's convention.
        ctx.scale(1, -1);
      }

      element.draw(ctx);

      ctx.restore();

      this.renderPins(ctx, element);

      if (selection.has(element)) {
        this._renderSelectionHighlight(ctx, element);
      }
      if (overlapSet.has(element)) {
        this._renderOverlapWarning(ctx, element);
      }
    }
  }

  /**
   * Draw pin indicators for all pins on an element.
   *
   * Pin positions from element.getPins() are in world space.
   * For each pin:
   *   - filled circle (PIN_CIRCLE_RADIUS) at pin position
   *   - if isNegated: additional unfilled circle (NEGATION_BUBBLE_RADIUS)
   *   - if isClock: small triangle indicator
   */
  renderPins(ctx: RenderContext, element: CircuitElement): void {
    ctx.setColor("PIN");
    for (const pin of element.getPins()) {
      const wp = pinWorldPosition(element, pin);
      ctx.drawCircle(wp.x, wp.y, PIN_CIRCLE_RADIUS, true);

      if (pin.isNegated) {
        this._renderNegationBubble(ctx, pin, element);
      }

      if (pin.isClock) {
        this._renderClockTriangle(ctx, pin, element);
      }
    }
  }

  /**
   * Draw an unfilled negation bubble between the pin and the body edge.
   *
   * Java GenericShape.drawInputInvert: bubble centered at (pinX + SIZE2, pinY),
   * i.e. 0.5 grid units toward the body from the (shifted) pin position.
   * Input pins are always on the west face, so "toward body" = +x in local space.
   */
  private _renderNegationBubble(ctx: RenderContext, pin: Pin, element: CircuitElement): void {
    const wp = pinWorldPosition(element, pin);
    // Offset 0.5 grid units from pin toward body (+x local, transformed to world)
    const offset = rotatePoint({ x: 0.5, y: 0 }, element.rotation as Rotation);
    // Java drawInputInvert uses Style.NORMAL (component color), not pin color
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(wp.x + offset.x, wp.y + offset.y, NEGATION_BUBBLE_RADIUS, false);
    // Restore pin color for subsequent pin drawing
    ctx.setColor("PIN");
  }

  /** Draw a small filled triangle indicating a clock pin. */
  private _renderClockTriangle(ctx: RenderContext, pin: Pin, element: CircuitElement): void {
    const { x, y } = pinWorldPosition(element, pin);
    ctx.drawPolygon(
      [
        { x: x - CLOCK_TRIANGLE_HALF, y: y - CLOCK_TRIANGLE_HALF },
        { x: x + CLOCK_TRIANGLE_HALF, y: y },
        { x: x - CLOCK_TRIANGLE_HALF, y: y + CLOCK_TRIANGLE_HALF },
      ],
      true,
    );
  }

  /** Draw a selection highlight outline around the element's world bounding box. */
  private _renderSelectionHighlight(ctx: RenderContext, element: CircuitElement): void {
    const bb = worldBoundingBox(element);
    ctx.setColor("SELECTION");
    ctx.setLineWidth(1);
    ctx.drawRect(bb.x, bb.y, bb.width, bb.height, false);
  }

  /**
   * Find all elements that share a position with at least one other element.
   * Uses a position key to group elements, then collects any group with 2+.
   */
  private _findOverlaps(elements: readonly CircuitElement[]): Set<CircuitElement> {
    const byPos = new Map<string, CircuitElement[]>();
    for (const el of elements) {
      const key = `${el.position.x},${el.position.y}`;
      const arr = byPos.get(key);
      if (arr) arr.push(el);
      else byPos.set(key, [el]);
    }
    const result = new Set<CircuitElement>();
    for (const group of byPos.values()) {
      if (group.length > 1) {
        for (const el of group) result.add(el);
      }
    }
    return result;
  }

  /**
   * Draw an overlap warning: a small filled triangle in the top-right corner
   * of the element's bounding box, using the error color.
   */
  private _renderOverlapWarning(ctx: RenderContext, element: CircuitElement): void {
    const bb = worldBoundingBox(element);
    const s = 0.6; // triangle size in grid units
    const rx = bb.x + bb.width;
    const ty = bb.y;
    ctx.setColor("WIRE_ERROR");
    ctx.drawPolygon(
      [
        { x: rx - s, y: ty },
        { x: rx, y: ty },
        { x: rx, y: ty + s },
      ],
      true,
    );
  }
}
