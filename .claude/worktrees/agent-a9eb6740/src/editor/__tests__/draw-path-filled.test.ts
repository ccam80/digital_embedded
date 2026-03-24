/**
 * Tests for R1 fix: drawPath() filled parameter.
 *
 * Covers:
 *   - CanvasRenderer.drawPath(path, true) calls ctx.fill(), not ctx.stroke()
 *   - CanvasRenderer.drawPath(path, false) calls ctx.stroke(), not ctx.fill()
 *   - CanvasRenderer.drawPath(path) with no second arg calls ctx.stroke() (default)
 *   - SVGRenderContext.drawPath(path, true) emits fill attrs without fill="none"
 *   - SVGRenderContext.drawPath(path, false) emits stroke attrs with fill="none"
 *   - IEEE AND gate draw() emits at least one drawPath call with filled=true
 *   - IEEE OR gate draw() emits at least one drawPath call with filled=true
 *   - IEEE NOT gate draw() emits at least one drawPath call with filled=true
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CanvasRenderer } from "@/editor/canvas-renderer";
import { SVGRenderContext } from "@/export/svg-render-context";
import { defaultColorScheme, lightColorScheme } from "@/core/renderer-interface";
import type { PathData, RenderContext, ThemeColor, TextAnchor, FontSpec, Point } from "@/core/renderer-interface";
import { AndElement } from "@/components/gates/and";
import { OrElement } from "@/components/gates/or";
import { NotElement } from "@/components/gates/not";
import { PropertyBag } from "@/core/properties";
import type { PropertyValue } from "@/core/properties";

// ---------------------------------------------------------------------------
// StubCanvas2D — records canvas method calls
// ---------------------------------------------------------------------------

interface CtxCall {
  method: string;
  args: unknown[];
}

class StubCanvas2D {
  readonly calls: CtxCall[] = [];
  strokeStyle: string = "#000000";
  fillStyle: string = "#000000";
  lineWidth: number = 1;
  font: string = "";
  textAlign: CanvasTextAlign = "left";
  textBaseline: CanvasTextBaseline = "alphabetic";

  private _record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  beginPath(): void { this._record("beginPath"); }
  moveTo(x: number, y: number): void { this._record("moveTo", x, y); }
  lineTo(x: number, y: number): void { this._record("lineTo", x, y); }
  arc(cx: number, cy: number, r: number, start: number, end: number): void { this._record("arc", cx, cy, r, start, end); }
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void { this._record("bezierCurveTo", cp1x, cp1y, cp2x, cp2y, x, y); }
  closePath(): void { this._record("closePath"); }
  stroke(): void { this._record("stroke"); }
  fill(): void { this._record("fill"); }
  fillRect(x: number, y: number, w: number, h: number): void { this._record("fillRect", x, y, w, h); }
  strokeRect(x: number, y: number, w: number, h: number): void { this._record("strokeRect", x, y, w, h); }
  fillText(text: string, x: number, y: number): void { this._record("fillText", text, x, y); }
  save(): void { this._record("save"); }
  restore(): void { this._record("restore"); }
  translate(dx: number, dy: number): void { this._record("translate", dx, dy); }
  rotate(angle: number): void { this._record("rotate", angle); }
  scale(sx: number, sy: number): void { this._record("scale", sx, sy); }
  setLineDash(pattern: number[]): void { this._record("setLineDash", pattern); }

  callsTo(method: string): CtxCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

// ---------------------------------------------------------------------------
// RenderContext stub that records drawPath calls with their filled argument
// ---------------------------------------------------------------------------

interface DrawPathCall {
  path: PathData;
  filled: boolean | undefined;
}

function makeStubCtx(): { ctx: RenderContext; pathCalls: DrawPathCall[] } {
  const pathCalls: DrawPathCall[] = [];

  const noop = (): void => {};

  const ctx: RenderContext = {
    drawLine: noop as (x1: number, y1: number, x2: number, y2: number) => void,
    drawRect: noop as (x: number, y: number, w: number, h: number, filled: boolean) => void,
    drawCircle: noop as (cx: number, cy: number, r: number, filled: boolean) => void,
    drawArc: noop as (cx: number, cy: number, r: number, s: number, e: number) => void,
    drawPolygon: noop as (points: readonly Point[], filled: boolean) => void,
    drawPath: (path: PathData, filled?: boolean): void => {
      pathCalls.push({ path, filled });
    },
    drawText: noop as (text: string, x: number, y: number, anchor: TextAnchor) => void,
    save: noop,
    restore: noop,
    translate: noop as (dx: number, dy: number) => void,
    rotate: noop as (angle: number) => void,
    scale: noop as (sx: number, sy: number) => void,
    setColor: noop as (color: ThemeColor) => void,
    setLineWidth: noop as (w: number) => void,
    setFont: noop as (font: FontSpec) => void,
    setLineDash: noop as (pattern: number[]) => void,
  };

  return { ctx, pathCalls };
}

const SIMPLE_PATH: PathData = {
  operations: [
    { op: "moveTo", x: 0, y: 0 },
    { op: "lineTo", x: 10, y: 0 },
    { op: "closePath" },
  ],
};

// ---------------------------------------------------------------------------
// CanvasRenderer.drawPath — filled parameter
// ---------------------------------------------------------------------------

describe("CanvasRenderer.drawPath", () => {
  let stub: StubCanvas2D;
  let renderer: CanvasRenderer;

  beforeEach(() => {
    stub = new StubCanvas2D();
    renderer = new CanvasRenderer(stub as unknown as CanvasRenderingContext2D, defaultColorScheme);
  });

  it("drawPath with filled=true calls fill() not stroke()", () => {
    renderer.drawPath(SIMPLE_PATH, true);

    expect(stub.callsTo("fill").length).toBe(1);
    expect(stub.callsTo("stroke").length).toBe(0);
  });

  it("drawPath with filled=false calls stroke() not fill()", () => {
    renderer.drawPath(SIMPLE_PATH, false);

    expect(stub.callsTo("stroke").length).toBe(1);
    expect(stub.callsTo("fill").length).toBe(0);
  });

  it("drawPath with no second argument calls stroke() not fill()", () => {
    renderer.drawPath(SIMPLE_PATH);

    expect(stub.callsTo("stroke").length).toBe(1);
    expect(stub.callsTo("fill").length).toBe(0);
  });

  it("drawPath always calls beginPath() before fill or stroke", () => {
    renderer.drawPath(SIMPLE_PATH, true);

    const beginIdx = stub.calls.findIndex((c) => c.method === "beginPath");
    const fillIdx = stub.calls.findIndex((c) => c.method === "fill");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(beginIdx).toBeLessThan(fillIdx);
  });
});

// ---------------------------------------------------------------------------
// SVGRenderContext.drawPath — filled parameter
// ---------------------------------------------------------------------------

describe("SVGRenderContext.drawPath", () => {
  it("drawPath with filled=true emits fill attribute without fill=none", () => {
    const ctx = new SVGRenderContext({ scheme: lightColorScheme });
    ctx.beginDocument();
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath(SIMPLE_PATH, true);

    const el = ctx.elements[0]!;
    expect(el).not.toContain('fill="none"');
    expect(el).toContain("fill=");
  });

  it("drawPath with filled=false emits stroke attribute with fill=none", () => {
    const ctx = new SVGRenderContext({ scheme: lightColorScheme });
    ctx.beginDocument();
    ctx.setColor("COMPONENT");
    ctx.drawPath(SIMPLE_PATH, false);

    const el = ctx.elements[0]!;
    expect(el).toContain('fill="none"');
    expect(el).toContain("stroke=");
  });

  it("drawPath with no second arg emits stroke attribute with fill=none", () => {
    const ctx = new SVGRenderContext({ scheme: lightColorScheme });
    ctx.beginDocument();
    ctx.drawPath(SIMPLE_PATH);

    const el = ctx.elements[0]!;
    expect(el).toContain('fill="none"');
    expect(el).toContain("stroke=");
  });

  it("drawPath filled=true uses current color as fill", () => {
    const ctx = new SVGRenderContext({ scheme: lightColorScheme });
    ctx.beginDocument();
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath(SIMPLE_PATH, true);

    const el = ctx.elements[0]!;
    const fillColor = lightColorScheme.resolve("COMPONENT_FILL");
    expect(el).toContain(`fill="${fillColor}"`);
  });
});

// ---------------------------------------------------------------------------
// IEEE gate shapes — fill pass uses filled=true
// ---------------------------------------------------------------------------

function makeProps(overrides: Record<string, PropertyValue>): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(overrides)) {
    bag.set(k, v);
  }
  return bag;
}

describe("IEEE gate shapes emit filled drawPath calls", () => {
  it("AND gate IEEE shape emits at least one drawPath with filled=true", () => {
    const props = makeProps({ inputCount: 2, bitWidth: 1, wideShape: true });
    const el = new AndElement("test", { x: 0, y: 0 }, 0, false, props);
    const { ctx, pathCalls } = makeStubCtx();

    el.draw(ctx);

    const filledCalls = pathCalls.filter((c) => c.filled === true);
    expect(filledCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("AND gate IEEE shape emits at least one drawPath with filled=false for stroke", () => {
    const props = makeProps({ inputCount: 2, bitWidth: 1, wideShape: true });
    const el = new AndElement("test", { x: 0, y: 0 }, 0, false, props);
    const { ctx, pathCalls } = makeStubCtx();

    el.draw(ctx);

    const strokeCalls = pathCalls.filter((c) => c.filled === false);
    expect(strokeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("AND gate narrow shape also uses drawPath (always IEEE now)", () => {
    const props = makeProps({ inputCount: 2, bitWidth: 1, wideShape: false });
    const el = new AndElement("test", { x: 0, y: 0 }, 0, false, props);
    const { ctx, pathCalls } = makeStubCtx();

    el.draw(ctx);

    expect(pathCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("OR gate IEEE shape emits at least one drawPath with filled=true", () => {
    const props = makeProps({ inputCount: 2, bitWidth: 1, wideShape: true });
    const el = new OrElement("test", { x: 0, y: 0 }, 0, false, props);
    const { ctx, pathCalls } = makeStubCtx();

    el.draw(ctx);

    const filledCalls = pathCalls.filter((c) => c.filled === true);
    expect(filledCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("NOT gate IEEE shape emits at least one drawPath with filled=true", () => {
    const props = makeProps({ bitWidth: 1, wideShape: true });
    const el = new NotElement("test", { x: 0, y: 0 }, 0, false, props);
    const { ctx, pathCalls } = makeStubCtx();

    el.draw(ctx);

    const filledCalls = pathCalls.filter((c) => c.filled === true);
    expect(filledCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("NOT gate IEEE shape emits exactly two drawPath calls (fill + stroke)", () => {
    const props = makeProps({ bitWidth: 1, wideShape: true });
    const el = new NotElement("test", { x: 0, y: 0 }, 0, false, props);
    const { ctx, pathCalls } = makeStubCtx();

    el.draw(ctx);

    expect(pathCalls.length).toBe(2);
    expect(pathCalls[0]!.filled).toBe(true);
    expect(pathCalls[1]!.filled).toBe(false);
  });

  it("AND gate IEEE shape emits exactly two drawPath calls (fill + stroke)", () => {
    const props = makeProps({ inputCount: 2, bitWidth: 1, wideShape: true });
    const el = new AndElement("test", { x: 0, y: 0 }, 0, false, props);
    const { ctx, pathCalls } = makeStubCtx();

    el.draw(ctx);

    expect(pathCalls.length).toBe(2);
    expect(pathCalls[0]!.filled).toBe(true);
    expect(pathCalls[1]!.filled).toBe(false);
  });
});
