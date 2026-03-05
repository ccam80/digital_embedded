/**
 * PNG circuit export.
 *
 * Renders a Circuit to a PNG Blob by creating an offscreen canvas at the
 * selected resolution, drawing through the existing CanvasRenderer, and
 * calling canvas.toBlob().
 *
 * The optional `canvasFactory` parameter allows tests to inject a stub canvas
 * without requiring a DOM environment.
 */

import type { Circuit } from "@/core/circuit";
import type { ColorScheme } from "@/core/renderer-interface";
import { lightColorScheme } from "@/core/renderer-interface";
import { CanvasRenderer } from "@/editor/canvas-renderer";
import { ElementRenderer } from "@/editor/element-renderer";
import { WireRenderer } from "@/editor/wire-renderer";
import type { WireSignalAccess } from "@/editor/wire-signal-access";

export interface PngExportOptions {
  /**
   * Pixel density multiplier relative to circuit world coordinates.
   * 1 = one pixel per world unit, 2 = 2x resolution, 4 = 4x resolution.
   * Default: 1.
   */
  scale?: 1 | 2 | 4;

  /**
   * Margin in world-coordinate units added on each side of the bounding box.
   * Default: 10.
   */
  margin?: number;

  /**
   * When true, the canvas is first filled with the BACKGROUND theme color.
   * Default: true.
   */
  background?: boolean;

  /**
   * Color scheme used for rendering. Default: lightColorScheme.
   */
  colorScheme?: ColorScheme;

  /**
   * When provided, wire colors reflect live signal values (snapshot mode).
   */
  wireSignalAccess?: WireSignalAccess;

  /**
   * Canvas factory for dependency injection in tests.
   * When omitted, document.createElement('canvas') is used.
   */
  canvasFactory?: (width: number, height: number) => PngCanvas;
}

/**
 * Minimal canvas interface required for PNG export.
 * Matches the relevant subset of HTMLCanvasElement.
 */
export interface PngCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
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

/**
 * Export a circuit to a PNG Blob.
 *
 * Creates a canvas at `scale` times the circuit's natural size, renders
 * using CanvasRenderer, and resolves with the resulting PNG Blob.
 */
export function exportPng(circuit: Circuit, options?: PngExportOptions): Promise<Blob> {
  const scale = options?.scale ?? 1;
  const margin = options?.margin ?? 10;
  const includeBackground = options?.background ?? true;
  const scheme = options?.colorScheme ?? lightColorScheme;
  const wireAccess = options?.wireSignalAccess;
  const factory = options?.canvasFactory;

  const bounds = computeCircuitBounds(circuit);

  const worldW = bounds.maxX - bounds.minX + margin * 2;
  const worldH = bounds.maxY - bounds.minY + margin * 2;

  const canvasW = Math.max(1, Math.round(worldW * scale));
  const canvasH = Math.max(1, Math.round(worldH * scale));

  const canvas = factory
    ? factory(canvasW, canvasH)
    : createBrowserCanvas(canvasW, canvasH);

  canvas.width = canvasW;
  canvas.height = canvasH;

  const ctx2d = canvas.getContext("2d");
  if (ctx2d === null) {
    return Promise.reject(new Error("Could not get 2D context from canvas"));
  }

  if (includeBackground) {
    ctx2d.fillStyle = scheme.resolve("BACKGROUND");
    ctx2d.fillRect(0, 0, canvasW, canvasH);
  }

  ctx2d.save();
  ctx2d.scale(scale, scale);
  ctx2d.translate(-bounds.minX + margin, -bounds.minY + margin);

  const renderer = new CanvasRenderer(ctx2d, scheme);

  const emptyWireSelection: ReadonlySet<import("@/core/circuit").Wire> = new Set();
  const wireRenderer = new WireRenderer();
  wireRenderer.render(renderer, circuit.wires, emptyWireSelection, wireAccess ?? undefined);

  const elementRenderer = new ElementRenderer();
  const emptySelection: ReadonlySet<import("@/core/element").CircuitElement> = new Set();
  const viewport = {
    x: bounds.minX - margin,
    y: bounds.minY - margin,
    width: worldW,
    height: worldH,
  };
  elementRenderer.render(renderer, circuit, emptySelection, viewport);

  ctx2d.restore();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("canvas.toBlob produced null"));
      } else {
        resolve(blob);
      }
    }, "image/png");
  });
}

function createBrowserCanvas(width: number, height: number): PngCanvas {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  return el as unknown as PngCanvas;
}
