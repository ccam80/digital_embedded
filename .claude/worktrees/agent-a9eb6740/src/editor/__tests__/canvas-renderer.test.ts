/**
 * Tests for CanvasRenderer.
 *
 * Uses a manual stub for CanvasRenderingContext2D that records method calls
 * and tracks property assignments. No DOM or jest-canvas-mock required.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CanvasRenderer } from "@/editor/canvas-renderer";
import {
  defaultColorScheme,
  highContrastColorScheme,
} from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// Manual CanvasRenderingContext2D stub
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

  /** Return all recorded calls with the given method name. */
  callsTo(method: string): CtxCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Return the index of the first call with the given method, or -1. */
  indexOfCall(method: string): number {
    return this.calls.findIndex((c) => c.method === method);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CanvasRenderer", () => {
  let stub: StubCanvas2D;
  let renderer: CanvasRenderer;

  beforeEach(() => {
    stub = new StubCanvas2D();
    renderer = new CanvasRenderer(stub as unknown as CanvasRenderingContext2D, defaultColorScheme);
  });

  it("delegatesDrawLine", () => {
    renderer.drawLine(0, 0, 10, 10);

    expect(stub.callsTo("beginPath").length).toBe(1);
    expect(stub.callsTo("moveTo")[0]?.args).toEqual([0, 0]);
    expect(stub.callsTo("lineTo")[0]?.args).toEqual([10, 10]);
    expect(stub.callsTo("stroke").length).toBe(1);

    // Verify ordering: beginPath → moveTo → lineTo → stroke
    const beginIdx = stub.indexOfCall("beginPath");
    const moveIdx = stub.indexOfCall("moveTo");
    const lineIdx = stub.indexOfCall("lineTo");
    const strokeIdx = stub.indexOfCall("stroke");
    expect(beginIdx).toBeLessThan(moveIdx);
    expect(moveIdx).toBeLessThan(lineIdx);
    expect(lineIdx).toBeLessThan(strokeIdx);
  });

  it("resolvesThemeColors", () => {
    renderer.setColor("WIRE_HIGH");

    const expected = defaultColorScheme.resolve("WIRE_HIGH");
    expect(stub.strokeStyle).toBe(expected);
    expect(stub.fillStyle).toBe(expected);
  });

  it("switchesColorScheme", () => {
    renderer.setColorScheme(highContrastColorScheme);
    renderer.setColor("BACKGROUND");

    expect(stub.strokeStyle).toBe("#000000");
    expect(stub.fillStyle).toBe("#000000");
  });

  it("transformStack", () => {
    renderer.save();
    renderer.translate(5, 5);
    renderer.restore();

    const saveIdx = stub.indexOfCall("save");
    const translateIdx = stub.indexOfCall("translate");
    const restoreIdx = stub.indexOfCall("restore");

    expect(saveIdx).toBeLessThan(translateIdx);
    expect(translateIdx).toBeLessThan(restoreIdx);

    expect(stub.callsTo("save").length).toBe(1);
    expect(stub.callsTo("translate")[0]?.args).toEqual([5, 5]);
    expect(stub.callsTo("restore").length).toBe(1);
  });
});
