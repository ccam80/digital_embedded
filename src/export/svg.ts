/**
 * SVG circuit export.
 *
 * Renders a Circuit to an SVG string using SVGRenderContext. The caller
 * controls scale, margins, text format, background, and whether wire
 * colors reflect live signal state.
 */

import type { Circuit } from "@/core/circuit";
import type { ColorScheme } from "@/core/renderer-interface";
import { lightColorScheme } from "@/core/renderer-interface";
import { SVGRenderContext } from "./svg-render-context";
import type { TextFormat } from "./svg-render-context";
import { ElementRenderer } from "@/editor/element-renderer";
import { WireRenderer } from "@/editor/wire-renderer";
import type { WireSignalAccess } from "@/editor/wire-signal-access";

export interface SvgExportOptions {
  /**
   * Scale factor applied to all coordinates.
   * Default: 1. A value of 2 doubles all dimensions.
   */
  scale?: number;

  /**
   * Margin in world-coordinate units added on each side of the bounding box.
   * Default: 10.
   */
  margin?: number;

  /**
   * Text format for labels.
   * - 'plain': text as-is.
   * - 'latex': leading-slash negation → LaTeX \overline{} notation.
   * Default: 'plain'.
   */
  textFormat?: TextFormat;

  /**
   * When true, a background rect is drawn in the BACKGROUND theme color.
   * Default: true.
   */
  background?: boolean;

  /**
   * Color scheme used for rendering. Default: lightColorScheme.
   */
  colorScheme?: ColorScheme;

  /**
   * When provided, wire colors reflect live signal values from this accessor
   * (live-state snapshot mode). When omitted, wires are rendered in the
   * default WIRE color (schematic-only mode).
   */
  wireSignalAccess?: WireSignalAccess;
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
 * Export a circuit to an SVG string.
 *
 * Uses SVGRenderContext (implementing RenderContext) and the existing
 * ElementRenderer / WireRenderer for rendering- the same code path as
 * the Canvas2D renderer.
 */
export function exportSvg(circuit: Circuit, options?: SvgExportOptions): string {
  const scale = options?.scale ?? 1;
  const margin = options?.margin ?? 10;
  const textFormat = options?.textFormat ?? "plain";
  const includeBackground = options?.background ?? true;
  const scheme = options?.colorScheme ?? lightColorScheme;
  const wireAccess = options?.wireSignalAccess;

  const bounds = computeCircuitBounds(circuit);

  const contentW = (bounds.maxX - bounds.minX + margin * 2) * scale;
  const contentH = (bounds.maxY - bounds.minY + margin * 2) * scale;

  const ctx = new SVGRenderContext({ scheme, textFormat });
  ctx.beginDocument();

  // Apply transform so that circuit world coords map into SVG space.
  // Translate so minX/minY land at (margin, margin) in scaled space.
  ctx.scale(scale, scale);
  ctx.translate(-bounds.minX + margin, -bounds.minY + margin);

  const selection: ReadonlySet<import("@/core/element").CircuitElement> = new Set();
  const viewport = {
    x: bounds.minX - margin,
    y: bounds.minY - margin,
    width: bounds.maxX - bounds.minX + margin * 2,
    height: bounds.maxY - bounds.minY + margin * 2,
  };

  // Draw wires first (behind components).
  const wireRenderer = new WireRenderer();
  const emptyWireSelection: ReadonlySet<import("@/core/circuit").Wire> = new Set();
  wireRenderer.render(ctx, circuit.wires, emptyWireSelection, wireAccess ?? undefined);

  // Draw elements on top.
  const elementRenderer = new ElementRenderer();
  elementRenderer.render(ctx, circuit, selection, viewport);

  const bgColor = includeBackground ? scheme.resolve("BACKGROUND") : undefined;

  return ctx.finishDocument(0, 0, contentW, contentH, ...(bgColor !== undefined ? [{ background: bgColor }] : []));
}
