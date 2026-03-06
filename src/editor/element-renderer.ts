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
import type { Pin } from "@/core/pin";

/** Radius of the filled circle drawn at each pin position. */
const PIN_CIRCLE_RADIUS = 2;

/** Radius of the unfilled negation bubble drawn outside the pin circle. */
const NEGATION_BUBBLE_RADIUS = 3;

/** Half-size of the clock triangle indicator. */
const CLOCK_TRIANGLE_HALF = 3;

/**
 * Returns true if the element's bounding box intersects the given viewport rect.
 * Both are in world (grid) coordinates.
 */
function isVisible(element: CircuitElement, viewport: Rect): boolean {
  const bb = element.getBoundingBox();
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
    for (const element of circuit.elements) {
      if (!isVisible(element, viewport)) {
        continue;
      }

      ctx.save();
      ctx.translate(element.position.x, element.position.y);

      if (element.rotation !== 0) {
        ctx.rotate((element.rotation * Math.PI) / 2);
      }
      if (element.mirror) {
        ctx.scale(-1, 1);
      }

      element.draw(ctx);

      ctx.restore();

      this.renderPins(ctx, element);

      if (selection.has(element)) {
        this._renderSelectionHighlight(ctx, element);
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
      ctx.drawCircle(pin.position.x, pin.position.y, PIN_CIRCLE_RADIUS, true);

      if (pin.isNegated) {
        this._renderNegationBubble(ctx, pin);
      }

      if (pin.isClock) {
        this._renderClockTriangle(ctx, pin);
      }
    }
  }

  /** Draw an unfilled negation bubble at the pin position. */
  private _renderNegationBubble(ctx: RenderContext, pin: Pin): void {
    ctx.drawCircle(pin.position.x, pin.position.y, NEGATION_BUBBLE_RADIUS, false);
  }

  /** Draw a small filled triangle indicating a clock pin. */
  private _renderClockTriangle(ctx: RenderContext, pin: Pin): void {
    const { x, y } = pin.position;
    ctx.drawPolygon(
      [
        { x: x - CLOCK_TRIANGLE_HALF, y: y - CLOCK_TRIANGLE_HALF },
        { x: x + CLOCK_TRIANGLE_HALF, y: y },
        { x: x - CLOCK_TRIANGLE_HALF, y: y + CLOCK_TRIANGLE_HALF },
      ],
      true,
    );
  }

  /** Draw a selection highlight outline around the element's bounding box. */
  private _renderSelectionHighlight(ctx: RenderContext, element: CircuitElement): void {
    const bb = element.getBoundingBox();
    ctx.setColor("SELECTION");
    ctx.setLineWidth(1);
    ctx.drawRect(bb.x, bb.y, bb.width, bb.height, false);
  }
}
