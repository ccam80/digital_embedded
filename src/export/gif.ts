/**
 * Animated GIF circuit export.
 *
 * Records simulation steps as canvas frames and encodes them into an animated
 * GIF using gifenc (pure-JS, works in browser and Node).
 *
 * Process:
 * 1. For each step: call engine.step(), render circuit to offscreen canvas,
 *    capture RGBA pixel data from the canvas.
 * 2. Quantize and palette-map each frame.
 * 3. Encode frames into a GIF with the requested frame delay.
 * 4. Return the GIF as a Blob.
 *
 * The optional `frameCapture` parameter allows tests to inject synthetic frame
 * data without requiring a DOM or canvas environment.
 */

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import type { Circuit } from "@/core/circuit";
import type { SimulationEngine } from "@/core/engine-interface";
import type { ColorScheme } from "@/core/renderer-interface";
import { lightColorScheme } from "@/core/renderer-interface";
import { CanvasRenderer } from "@/editor/canvas-renderer";
import { ElementRenderer } from "@/editor/element-renderer";
import { WireRenderer } from "@/editor/wire-renderer";
import type { PngCanvas } from "./png";

export interface GifExportOptions {
  /**
   * Number of simulation steps to capture as frames.
   * Default: 10.
   */
  steps?: number;

  /**
   * Delay between frames in milliseconds (GIF centiseconds internally).
   * Default: 100.
   */
  frameDelay?: number;

  /**
   * Pixel density multiplier relative to circuit world coordinates.
   * Default: 1.
   */
  scale?: 1 | 2 | 4;

  /**
   * Margin in world-coordinate units added on each side.
   * Default: 10.
   */
  margin?: number;

  /**
   * Color scheme used for rendering. Default: lightColorScheme.
   */
  colorScheme?: ColorScheme;

  /**
   * Canvas factory for dependency injection in tests.
   * When omitted, document.createElement('canvas') is used.
   */
  canvasFactory?: (width: number, height: number) => PngCanvas;

  /**
   * Frame capture override for dependency injection in tests.
   *
   * When provided, this function is called once per step instead of the
   * default canvas-based capture. It receives the step index (0-based) and
   * must return a flat RGBA Uint8ClampedArray of length width * height * 4.
   *
   * The returned array is used directly for color quantization.
   */
  frameCapture?: (
    stepIndex: number,
    width: number,
    height: number,
  ) => Uint8ClampedArray;
}

/**
 * Compute the bounding box of all elements and wires in the circuit,
 * in world coordinates.
 */
function computeCircuitBounds(circuit: Circuit): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of circuit.elements) {
    const bb = el.getBoundingBox();
    minX = Math.min(minX, bb.x);
    minY = Math.min(minY, bb.y);
    maxX = Math.max(maxX, bb.x + bb.width);
    maxY = Math.max(maxY, bb.y + bb.height);
  }

  for (const wire of circuit.wires) {
    minX = Math.min(minX, wire.start.x, wire.end.x);
    minY = Math.min(minY, wire.start.y, wire.end.y);
    maxX = Math.max(maxX, wire.start.x, wire.end.x);
    maxY = Math.max(maxY, wire.start.y, wire.end.y);
  }

  if (!isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  return { minX, minY, maxX, maxY };
}

function createBrowserCanvas(width: number, height: number): PngCanvas {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  return el as unknown as PngCanvas;
}

/**
 * Render the circuit to the canvas and capture pixel data.
 *
 * Returns a flat RGBA Uint8ClampedArray of length width * height * 4.
 */
function captureFrame(
  canvas: PngCanvas,
  circuit: Circuit,
  scheme: ColorScheme,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  scale: number,
  margin: number,
  canvasW: number,
  canvasH: number,
): Uint8ClampedArray {
  const ctx2d = canvas.getContext("2d");
  if (ctx2d === null) {
    throw new Error("Could not get 2D context from canvas");
  }

  ctx2d.clearRect(0, 0, canvasW, canvasH);
  ctx2d.fillStyle = scheme.resolve("BACKGROUND");
  ctx2d.fillRect(0, 0, canvasW, canvasH);

  ctx2d.save();
  ctx2d.scale(scale, scale);
  ctx2d.translate(-bounds.minX + margin, -bounds.minY + margin);

  const renderer = new CanvasRenderer(ctx2d, scheme);

  const emptyWireSelection: ReadonlySet<import("@/core/circuit").Wire> = new Set();
  const wireRenderer = new WireRenderer();
  wireRenderer.render(renderer, circuit.wires, emptyWireSelection, undefined);

  const elementRenderer = new ElementRenderer();
  const emptySelection: ReadonlySet<import("@/core/element").CircuitElement> =
    new Set();
  const worldW = bounds.maxX - bounds.minX + margin * 2;
  const worldH = bounds.maxY - bounds.minY + margin * 2;
  const viewport = {
    x: bounds.minX - margin,
    y: bounds.minY - margin,
    width: worldW,
    height: worldH,
  };
  elementRenderer.render(renderer, circuit, emptySelection, viewport);

  ctx2d.restore();

  return ctx2d.getImageData(0, 0, canvasW, canvasH).data;
}

/**
 * Export a circuit simulation as an animated GIF Blob.
 *
 * Advances the engine by `steps` steps, capturing a canvas frame after each
 * step, then encodes all frames into an animated GIF.
 */
export function exportGif(
  circuit: Circuit,
  engine: SimulationEngine,
  options?: GifExportOptions,
): Promise<Blob> {
  const steps = options?.steps ?? 10;
  const frameDelay = options?.frameDelay ?? 100;
  const scale = options?.scale ?? 1;
  const margin = options?.margin ?? 10;
  const scheme = options?.colorScheme ?? lightColorScheme;
  const factory = options?.canvasFactory;
  const frameCaptureOverride = options?.frameCapture;

  const bounds = computeCircuitBounds(circuit);

  const worldW = bounds.maxX - bounds.minX + margin * 2;
  const worldH = bounds.maxY - bounds.minY + margin * 2;

  const canvasW = Math.max(1, Math.round(worldW * scale));
  const canvasH = Math.max(1, Math.round(worldH * scale));

  // gifenc expects delay in milliseconds; it converts to GIF centiseconds internally.
  const delayMs = frameDelay;

  const gif = GIFEncoder();

  let canvas: PngCanvas | null = null;
  if (!frameCaptureOverride) {
    canvas = factory ? factory(canvasW, canvasH) : createBrowserCanvas(canvasW, canvasH);
    canvas.width = canvasW;
    canvas.height = canvasH;
  }

  for (let i = 0; i < steps; i++) {
    engine.step();

    let rgba: Uint8ClampedArray;
    if (frameCaptureOverride) {
      rgba = frameCaptureOverride(i, canvasW, canvasH);
    } else {
      rgba = captureFrame(canvas!, circuit, scheme, bounds, scale, margin, canvasW, canvasH);
    }

    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);

    gif.writeFrame(index, canvasW, canvasH, {
      palette,
      delay: delayMs,
    });
  }

  gif.finish();
  const bytes = gif.bytes();

  const blob = new Blob([bytes], { type: "image/gif" });
  return Promise.resolve(blob);
}
