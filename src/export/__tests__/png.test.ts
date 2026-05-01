/**
 * Tests for exportPng()- circuit-level PNG export.
 *
 * Spec tests:
 *   producesBlob  - export returns a Blob with type image/png
 *   scale2x       - scale=2 → canvas dimensions are 2x the circuit bounds
 *   scale4x       - scale=4 → canvas dimensions are 4x
 *
 * Runs in the node environment (no DOM). All canvas calls go to a stub
 * that records dimensions and returns a synthetic Blob.
 */

import { describe, it, expect } from "vitest";
import { exportPng } from "../png";
import type { PngCanvas } from "../png";
import { Circuit, Wire } from "@/core/circuit";
import { lightColorScheme } from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// Stub canvas
// ---------------------------------------------------------------------------

interface CtxCall {
  method: string;
  args: unknown[];
}

/**
 * Stub CanvasRenderingContext2D that records all calls.
 * The PNG export only requires a small subset of the 2D context API.
 */
class StubCtx2D {
  readonly calls: CtxCall[] = [];
  fillStyle: string = "#000000";
  strokeStyle: string = "#000000";
  lineWidth: number = 1;
  font: string = "";
  textAlign: string = "left";
  textBaseline: string = "alphabetic";

  private _record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  fillRect(x: number, y: number, w: number, h: number): void { this._record("fillRect", x, y, w, h); }
  strokeRect(x: number, y: number, w: number, h: number): void { this._record("strokeRect", x, y, w, h); }
  beginPath(): void { this._record("beginPath"); }
  moveTo(x: number, y: number): void { this._record("moveTo", x, y); }
  lineTo(x: number, y: number): void { this._record("lineTo", x, y); }
  arc(cx: number, cy: number, r: number, s: number, e: number): void { this._record("arc", cx, cy, r, s, e); }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void { this._record("bezierCurveTo", c1x, c1y, c2x, c2y, x, y); }
  closePath(): void { this._record("closePath"); }
  stroke(): void { this._record("stroke"); }
  fill(): void { this._record("fill"); }
  fillText(text: string, x: number, y: number): void { this._record("fillText", text, x, y); }
  save(): void { this._record("save"); }
  restore(): void { this._record("restore"); }
  translate(dx: number, dy: number): void { this._record("translate", dx, dy); }
  rotate(angle: number): void { this._record("rotate", angle); }
  scale(sx: number, sy: number): void { this._record("scale", sx, sy); }
  setLineDash(pattern: number[]): void { this._record("setLineDash", pattern); }
}

/**
 * Stub canvas that records what dimensions it was created with and returns
 * a synthetic image/png Blob from toBlob().
 */
class StubCanvas implements PngCanvas {
  width: number;
  height: number;
  readonly ctx: StubCtx2D = new StubCtx2D();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(type: "2d"): CanvasRenderingContext2D | null {
    if (type === "2d") {
      return this.ctx as unknown as CanvasRenderingContext2D;
    }
    return null;
  }

  toBlob(callback: (blob: Blob | null) => void, type?: string): void {
    const mimeType = type ?? "image/png";
    const blob = new Blob(["PNG_STUB_DATA"], { type: mimeType });
    callback(blob);
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

let lastCanvas: StubCanvas | null = null;

function stubFactory(width: number, height: number): PngCanvas {
  lastCanvas = new StubCanvas(width, height);
  return lastCanvas;
}

// ---------------------------------------------------------------------------
// Circuit helpers
// ---------------------------------------------------------------------------

/** A circuit with a wire spanning from (0,0) to (40,0). */
function buildWireCircuit(): Circuit {
  const circuit = new Circuit({ name: "wire-test" });
  circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 40, y: 0 }));
  return circuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exportPng", () => {
  it("producesBlob- export returns a Blob with type image/png", async () => {
    const circuit = buildWireCircuit();
    const blob = await exportPng(circuit, {
      scale: 1,
      colorScheme: lightColorScheme,
      canvasFactory: stubFactory,
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
  });

  it("scale2x- scale=2 produces canvas dimensions 2x circuit bounds", async () => {
    const circuit = buildWireCircuit();

    // Capture scale=1 canvas size
    let canvas1: StubCanvas | null = null;
    await exportPng(circuit, {
      scale: 1,
      margin: 10,
      colorScheme: lightColorScheme,
      canvasFactory: (w, h) => {
        canvas1 = new StubCanvas(w, h);
        return canvas1;
      },
    });

    // Capture scale=2 canvas size
    let canvas2: StubCanvas | null = null;
    await exportPng(circuit, {
      scale: 2,
      margin: 10,
      colorScheme: lightColorScheme,
      canvasFactory: (w, h) => {
        canvas2 = new StubCanvas(w, h);
        return canvas2;
      },
    });

    expect(canvas1).not.toBeNull();
    expect(canvas2).not.toBeNull();

    expect(canvas2!.width).toBe(canvas1!.width * 2);
    expect(canvas2!.height).toBe(canvas1!.height * 2);
  });

  it("scale4x- scale=4 produces canvas dimensions 4x circuit bounds", async () => {
    const circuit = buildWireCircuit();

    let canvas1: StubCanvas | null = null;
    await exportPng(circuit, {
      scale: 1,
      margin: 10,
      colorScheme: lightColorScheme,
      canvasFactory: (w, h) => {
        canvas1 = new StubCanvas(w, h);
        return canvas1;
      },
    });

    let canvas4: StubCanvas | null = null;
    await exportPng(circuit, {
      scale: 4,
      margin: 10,
      colorScheme: lightColorScheme,
      canvasFactory: (w, h) => {
        canvas4 = new StubCanvas(w, h);
        return canvas4;
      },
    });

    expect(canvas1).not.toBeNull();
    expect(canvas4).not.toBeNull();

    expect(canvas4!.width).toBe(canvas1!.width * 4);
    expect(canvas4!.height).toBe(canvas1!.height * 4);
  });

  it("background=true fills the canvas with background color before rendering", async () => {
    const circuit = buildWireCircuit();
    let capturedCtx: StubCtx2D | null = null;

    await exportPng(circuit, {
      scale: 1,
      background: true,
      colorScheme: lightColorScheme,
      canvasFactory: (w, h) => {
        const c = new StubCanvas(w, h);
        capturedCtx = c.ctx;
        return c;
      },
    });

    expect(capturedCtx).not.toBeNull();
    const fillRects = capturedCtx!.calls.filter((c) => c.method === "fillRect");
    expect(fillRects.length).toBeGreaterThan(0);
  });

  it("background=false does not fill canvas background", async () => {
    const circuit = new Circuit({ name: "empty" });
    let capturedCtx: StubCtx2D | null = null;

    await exportPng(circuit, {
      scale: 1,
      background: false,
      colorScheme: lightColorScheme,
      canvasFactory: (w, h) => {
        const c = new StubCanvas(w, h);
        capturedCtx = c.ctx;
        return c;
      },
    });

    expect(capturedCtx).not.toBeNull();
    // With empty circuit and no background, no fillRect for the background
    // The only fillRects would come from element rendering- empty circuit has none
    const fillRects = capturedCtx!.calls.filter((c) => c.method === "fillRect");
    expect(fillRects.length).toBe(0);
  });

  it("empty circuit still produces a Blob", async () => {
    const circuit = new Circuit({ name: "empty" });
    const blob = await exportPng(circuit, {
      scale: 1,
      colorScheme: lightColorScheme,
      canvasFactory: stubFactory,
    });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
  });
});
