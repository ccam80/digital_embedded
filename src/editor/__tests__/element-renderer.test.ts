/**
 * Tests for ElementRenderer.
 *
 * Uses MockRenderContext to capture draw calls without a real canvas.
 * Uses minimal stub CircuitElement implementations to control pin layouts,
 * bounding boxes, and draw behaviour.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ElementRenderer } from "../element-renderer.js";
import { MockRenderContext } from "@/test-utils/mock-render-context";
import { Circuit } from "@/core/circuit";
import { AbstractCircuitElement } from "@/core/element";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import { PropertyBag } from "@/core/properties";

// ---------------------------------------------------------------------------
// Stub element factory
// ---------------------------------------------------------------------------

interface StubElementOptions {
  position?: { x: number; y: number };
  rotation?: 0 | 1 | 2 | 3;
  mirror?: boolean;
  pins?: Pin[];
  boundingBox?: Rect;
  drawFn?: (ctx: RenderContext) => void;
}

function makePin(
  x: number,
  y: number,
  isNegated = false,
  isClock = false,
): Pin {
  return {
    direction: PinDirection.INPUT,
    position: { x, y },
    label: "p",
    bitWidth: 1,
    isNegated,
    isClock,
  };
}

class StubElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];
  private readonly _bb: Rect;
  private readonly _drawFn: (ctx: RenderContext) => void;
  drawCallCount = 0;

  constructor(opts: StubElementOptions = {}) {
    super(
      "Stub",
      "stub-id",
      opts.position ?? { x: 0, y: 0 },
      opts.rotation ?? 0,
      opts.mirror ?? false,
      new PropertyBag(),
    );
    this._pins = opts.pins ?? [];
    this._bb = opts.boundingBox ?? {
      x: opts.position?.x ?? 0,
      y: opts.position?.y ?? 0,
      width: 4,
      height: 4,
    };
    this._drawFn = opts.drawFn ?? (() => {});
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return this._bb;
  }

  draw(ctx: RenderContext): void {
    this.drawCallCount++;
    this._drawFn(ctx);
  }

}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ElementRenderer", () => {
  let renderer: ElementRenderer;
  let ctx: MockRenderContext;

  /** Viewport large enough to contain any element placed near the origin. */
  const fullViewport: Rect = { x: -100, y: -100, width: 500, height: 500 };

  beforeEach(() => {
    renderer = new ElementRenderer();
    ctx = new MockRenderContext();
  });

  // -------------------------------------------------------------------------

  it("drawsElementWithTransform", () => {
    const element = new StubElement({
      position: { x: 5, y: 3 },
      rotation: 1,
      boundingBox: { x: 5, y: 3, width: 4, height: 4 },
    });
    const circuit = new Circuit();
    circuit.addElement(element);

    renderer.render(ctx, circuit, new Set(), fullViewport);

    const calls = ctx.calls;

    // save must appear before translate
    const saveIdx = calls.findIndex((c) => c.kind === "save");
    expect(saveIdx).toBeGreaterThanOrEqual(0);

    // translate(5, 3) must follow save
    const translateIdx = calls.findIndex(
      (c, i) => i > saveIdx && c.kind === "translate" && c.dx === 5 && c.dy === 3,
    );
    expect(translateIdx).toBeGreaterThan(saveIdx);

    // rotate(-Math.PI / 2) for rotation=1 (negated to match rotatePoint convention)
    const rotateIdx = calls.findIndex(
      (c, i) =>
        i > translateIdx &&
        c.kind === "rotate" &&
        Math.abs((c as { kind: "rotate"; angle: number }).angle + Math.PI / 2) < 1e-10,
    );
    expect(rotateIdx).toBeGreaterThan(translateIdx);

    // element.draw() was called (drawCallCount incremented)
    expect(element.drawCallCount).toBe(1);

    // restore appears at the end of the element transform block
    const restoreIdx = calls.findIndex((c, i) => i > rotateIdx && c.kind === "restore");
    expect(restoreIdx).toBeGreaterThan(rotateIdx);
  });

  // -------------------------------------------------------------------------

  it("drawsPinIndicators", () => {
    const pin1 = makePin(2, 3);
    const pin2 = makePin(6, 3);
    const element = new StubElement({
      pins: [pin1, pin2],
      boundingBox: { x: 0, y: 0, width: 8, height: 6 },
    });
    const circuit = new Circuit();
    circuit.addElement(element);

    renderer.render(ctx, circuit, new Set(), fullViewport);

    const circles = ctx.callsOfKind("circle").filter((c) => c.filled);
    const positions = circles.map((c) => ({ x: c.cx, y: c.cy }));

    expect(positions).toContainEqual({ x: 2, y: 3 });
    expect(positions).toContainEqual({ x: 6, y: 3 });
  });

  // -------------------------------------------------------------------------

  it("drawsNegationBubble", () => {
    const negatedPin = makePin(3, 2, true, false);
    const element = new StubElement({
      pins: [negatedPin],
      boundingBox: { x: 0, y: 0, width: 4, height: 4 },
    });
    const circuit = new Circuit();
    circuit.addElement(element);

    renderer.render(ctx, circuit, new Set(), fullViewport);

    // Negation bubble is offset 0.5 grid units toward body (+x for rotation=0)
    const unfilledCircles = ctx
      .callsOfKind("circle")
      .filter((c) => !c.filled && c.cx === 3.5 && c.cy === 2);

    expect(unfilledCircles).toHaveLength(1);
  });

  // -------------------------------------------------------------------------

  it("drawsSelectionHighlight", () => {
    const element = new StubElement({
      position: { x: 1, y: 1 },
      boundingBox: { x: 1, y: 1, width: 4, height: 4 },
    });
    const circuit = new Circuit();
    circuit.addElement(element);
    const selection = new Set([element as import("@/core/element").CircuitElement]);

    renderer.render(ctx, circuit, selection, fullViewport);

    // setColor("SELECTION") must appear
    const selectionColors = ctx.callsOfKind("setColor").filter((c) => c.color === "SELECTION");
    expect(selectionColors.length).toBeGreaterThanOrEqual(1);

    // An unfilled rect matching the bounding box must appear after SELECTION color
    const selectionColorIdx = ctx.calls.findIndex(
      (c) => c.kind === "setColor" && (c as { kind: "setColor"; color: string }).color === "SELECTION",
    );
    const selectionRect = ctx.calls
      .slice(selectionColorIdx)
      .find(
        (c) =>
          c.kind === "rect" &&
          !( c as { kind: "rect"; filled: boolean }).filled &&
          (c as { kind: "rect"; x: number }).x === 1 &&
          (c as { kind: "rect"; y: number }).y === 1 &&
          (c as { kind: "rect"; width: number }).width === 4 &&
          (c as { kind: "rect"; height: number }).height === 4,
      );
    expect(selectionRect).not.toBeUndefined();
  });

  // -------------------------------------------------------------------------

  it("cullsOffscreenElements", () => {
    // Place element far outside the viewport
    const element = new StubElement({
      position: { x: 1000, y: 1000 },
      boundingBox: { x: 1000, y: 1000, width: 4, height: 4 },
    });
    const circuit = new Circuit();
    circuit.addElement(element);

    // Small viewport that does not reach the element
    const tinyViewport: Rect = { x: 0, y: 0, width: 50, height: 50 };

    renderer.render(ctx, circuit, new Set(), tinyViewport);

    // No draw calls should have been made
    expect(element.drawCallCount).toBe(0);
    const drawCalls = ctx.calls.filter(
      (c) => c.kind !== "setColor" && c.kind !== "setLineWidth",
    );
    expect(drawCalls.length).toBe(0);
  });
});
