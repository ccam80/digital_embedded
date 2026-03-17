/**
 * Software rasterizer for shape comparison testing.
 *
 * Converts draw calls (from both Java Digital fixtures and TS MockRenderContext)
 * into line segments, rasterizes them to binary bitmaps, and compares.
 * Zero external dependencies — all rasterization is done in pure TypeScript.
 *
 * Design: both Java and TS draw calls are first converted to a uniform list of
 * LineSegments (outline edges). This normalizes across primitive types (polygon,
 * rect, path, circle, arc) so the comparison is purely geometric. Text draw
 * calls are excluded from pixel comparison and handled structurally.
 */

import type { PathData } from "@/core/renderer-interface";
import type { DrawCall } from "./mock-render-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Viewport {
  width: number;
  height: number;
  toPixelX(gridX: number): number;
  toPixelY(gridY: number): number;
}

export interface CompareResult {
  /** Soft Dice coefficient (0–1) with 1px tolerance. 1.0 = perfect match. */
  dice: number;
  litA: number;
  litB: number;
  matchedA: number;
  matchedB: number;
}

export interface TextEntry {
  text: string;
  x: number;
  y: number;
  horizontal: "left" | "center" | "right";
  vertical: "top" | "middle" | "bottom";
}

export interface TextCompareResult {
  matched: Array<{ java: TextEntry; ts: TextEntry; posDiff: number }>;
  missingInTS: TextEntry[];
  extraInTS: TextEntry[];
}

export interface ExtentResult {
  javaW: number;
  javaH: number;
  tsW: number;
  tsH: number;
  /** TS width minus Java width (positive = TS wider) */
  widthDelta: number;
  /** TS height minus Java height (positive = TS taller) */
  heightDelta: number;
  /** Center X offset (TS center - Java center) */
  centerDx: number;
  /** Center Y offset (TS center - Java center) */
  centerDy: number;
  /** Max absolute delta across all four metrics */
  maxDelta: number;
}

/** Raw Java fixture draw call (untyped on purpose — mirrors the JSON). */
export interface JavaDrawCall {
  kind: string;
  path?: string;
  points?: Array<{ cmd: string; x: number; y: number }>;
  closed?: boolean;
  style?: string;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  text?: string;
  x?: number;
  y?: number;
  orientation?: string;
}

// ---------------------------------------------------------------------------
// Bitmap
// ---------------------------------------------------------------------------

export class Bitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.data = new Uint8Array(w * h);
  }

  set(x: number, y: number): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix >= 0 && ix < this.width && iy >= 0 && iy < this.height) {
      this.data[iy * this.width + ix] = 1;
    }
  }

  get(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    return this.data[y * this.width + x];
  }
}

// ---------------------------------------------------------------------------
// Bresenham line rasterization
// ---------------------------------------------------------------------------

function rasterLine(
  bmp: Bitmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  let ix0 = Math.round(x0);
  let iy0 = Math.round(y0);
  const ix1 = Math.round(x1);
  const iy1 = Math.round(y1);
  const dx = Math.abs(ix1 - ix0);
  const dy = Math.abs(iy1 - iy0);
  const sx = ix0 < ix1 ? 1 : -1;
  const sy = iy0 < iy1 ? 1 : -1;
  let err = dx - dy;

  for (;;) {
    bmp.set(ix0, iy0);
    if (ix0 === ix1 && iy0 === iy1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      ix0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      iy0 += sy;
    }
  }
}

// ---------------------------------------------------------------------------
// Cubic Bézier flattening (de Casteljau subdivision)
// ---------------------------------------------------------------------------

function flattenCubicBezier(
  x0: number,
  y0: number,
  cp1x: number,
  cp1y: number,
  cp2x: number,
  cp2y: number,
  x1: number,
  y1: number,
  out: Array<{ x: number; y: number }>,
  tol = 0.5,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d2 = dx * dx + dy * dy;
  if (d2 < 1e-6) {
    out.push({ x: x1, y: y1 });
    return;
  }
  const d1 = Math.abs((cp1x - x1) * dy - (cp1y - y1) * dx);
  const d2v = Math.abs((cp2x - x1) * dy - (cp2y - y1) * dx);
  if ((d1 + d2v) * (d1 + d2v) <= tol * tol * d2) {
    out.push({ x: x1, y: y1 });
    return;
  }
  // de Casteljau split at t=0.5
  const m01x = (x0 + cp1x) / 2,
    m01y = (y0 + cp1y) / 2;
  const m12x = (cp1x + cp2x) / 2,
    m12y = (cp1y + cp2y) / 2;
  const m23x = (cp2x + x1) / 2,
    m23y = (cp2y + y1) / 2;
  const m012x = (m01x + m12x) / 2,
    m012y = (m01y + m12y) / 2;
  const m123x = (m12x + m23x) / 2,
    m123y = (m12y + m23y) / 2;
  const mx = (m012x + m123x) / 2,
    my = (m012y + m123y) / 2;

  flattenCubicBezier(x0, y0, m01x, m01y, m012x, m012y, mx, my, out, tol);
  flattenCubicBezier(mx, my, m123x, m123y, m23x, m23y, x1, y1, out, tol);
}

// ---------------------------------------------------------------------------
// SVG path parser (for Java fixture `path` strings)
// Handles M, L, C, Q, Z — pixel coordinates, scaled by `s` (typically 1/20)
// ---------------------------------------------------------------------------

function parseSvgPathToPoints(
  d: string,
  s: number,
): Array<{ x: number; y: number }> {
  const tokens = d.trim().split(/\s+/);
  const pts: Array<{ x: number; y: number }> = [];
  let i = 0;
  let cx = 0,
    cy = 0;

  function pair(): { x: number; y: number } {
    const parts = tokens[i++].split(",");
    return { x: parseFloat(parts[0]) * s, y: parseFloat(parts[1]) * s };
  }

  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case "M": {
        const p = pair();
        cx = p.x;
        cy = p.y;
        pts.push(p);
        break;
      }
      case "L": {
        const p = pair();
        cx = p.x;
        cy = p.y;
        pts.push(p);
        break;
      }
      case "C": {
        const cp1 = pair();
        const cp2 = pair();
        const end = pair();
        flattenCubicBezier(
          cx,
          cy,
          cp1.x,
          cp1.y,
          cp2.x,
          cp2.y,
          end.x,
          end.y,
          pts,
        );
        cx = end.x;
        cy = end.y;
        break;
      }
      case "Q": {
        // Promote quadratic to cubic
        const qcp = pair();
        const qend = pair();
        const c1x = cx + (2 / 3) * (qcp.x - cx);
        const c1y = cy + (2 / 3) * (qcp.y - cy);
        const c2x = qend.x + (2 / 3) * (qcp.x - qend.x);
        const c2y = qend.y + (2 / 3) * (qcp.y - qend.y);
        flattenCubicBezier(cx, cy, c1x, c1y, c2x, c2y, qend.x, qend.y, pts);
        cx = qend.x;
        cy = qend.y;
        break;
      }
      case "Z":
        // Closing edge handled by caller (closed flag)
        break;
      default:
        // Unknown command — skip
        break;
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------
// TS PathData → points
// ---------------------------------------------------------------------------

function pathDataToPoints(
  pathData: PathData,
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  let cx = 0,
    cy = 0;

  for (const op of pathData.operations) {
    switch (op.op) {
      case "moveTo":
        cx = op.x;
        cy = op.y;
        pts.push({ x: cx, y: cy });
        break;
      case "lineTo":
        cx = op.x;
        cy = op.y;
        pts.push({ x: cx, y: cy });
        break;
      case "curveTo":
        flattenCubicBezier(
          cx,
          cy,
          op.cp1x,
          op.cp1y,
          op.cp2x,
          op.cp2y,
          op.x,
          op.y,
          pts,
        );
        cx = op.x;
        cy = op.y;
        break;
      case "closePath":
        break;
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Circle / ellipse / arc → line segments (polygon approximation)
// ---------------------------------------------------------------------------

function ellipseSegments(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): LineSegment[] {
  const segs: LineSegment[] = [];
  const r = Math.max(rx, ry);
  if (r < 0.01) return segs;
  const n = Math.max(Math.ceil(r * 40), 16);
  for (let i = 0; i < n; i++) {
    const a1 = (2 * Math.PI * i) / n;
    const a2 = (2 * Math.PI * (i + 1)) / n;
    segs.push({
      x1: cx + rx * Math.cos(a1),
      y1: cy + ry * Math.sin(a1),
      x2: cx + rx * Math.cos(a2),
      y2: cy + ry * Math.sin(a2),
    });
  }
  // Add cardinal-point sentinels so segmentBounds returns exact cx±rx, cy±ry.
  // These zero-length degenerate segments do not affect rasterization.
  segs.push({ x1: cx + rx, y1: cy, x2: cx + rx, y2: cy });
  segs.push({ x1: cx - rx, y1: cy, x2: cx - rx, y2: cy });
  segs.push({ x1: cx, y1: cy + ry, x2: cx, y2: cy + ry });
  segs.push({ x1: cx, y1: cy - ry, x2: cx, y2: cy - ry });
  return segs;
}

function arcSegments(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): LineSegment[] {
  const segs: LineSegment[] = [];
  const sweep = endAngle - startAngle;
  const n = Math.max(Math.ceil(Math.abs(sweep) * r * 6), 8);
  for (let i = 0; i < n; i++) {
    const a1 = startAngle + (sweep * i) / n;
    const a2 = startAngle + (sweep * (i + 1)) / n;
    segs.push({
      x1: cx + r * Math.cos(a1),
      y1: cy + r * Math.sin(a1),
      x2: cx + r * Math.cos(a2),
      y2: cy + r * Math.sin(a2),
    });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Points → closing edge helper
// ---------------------------------------------------------------------------

function polylineSegments(
  pts: Array<{ x: number; y: number }>,
  close: boolean,
): LineSegment[] {
  const segs: LineSegment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({
      x1: pts[i].x,
      y1: pts[i].y,
      x2: pts[i + 1].x,
      y2: pts[i + 1].y,
    });
  }
  if (close && pts.length > 1) {
    const last = pts[pts.length - 1];
    const first = pts[0];
    if (
      Math.abs(last.x - first.x) > 0.01 ||
      Math.abs(last.y - first.y) > 0.01
    ) {
      segs.push({ x1: last.x, y1: last.y, x2: first.x, y2: first.y });
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Java draw calls → line segments
// ---------------------------------------------------------------------------

const PIXEL_TO_GRID = 1 / 20;

export function javaCallsToSegments(calls: JavaDrawCall[]): LineSegment[] {
  const segs: LineSegment[] = [];

  for (const call of calls) {
    switch (call.kind) {
      case "polygon": {
        // Use pre-computed points array (exact grid-unit values) for straight-line
        // polygons to avoid integer/20 ULP float errors from SVG path parsing.
        // But for curved polygons (C/Q commands), use SVG path which preserves
        // Bezier curve information that the points[] array flattens away.
        const hasCurves = call.points?.some(
          (p) => p.cmd === "C" || p.cmd === "Q" || p.cmd === "CurveTo" || p.cmd === "QuadTo",
        );
        if (call.points && !hasCurves) {
          const pts = call.points.map((p) => ({ x: p.x, y: p.y }));
          segs.push(...polylineSegments(pts, call.closed ?? false));
        } else if (call.path) {
          const pts = parseSvgPathToPoints(call.path, PIXEL_TO_GRID);
          segs.push(...polylineSegments(pts, call.closed ?? false));
        }
        break;
      }
      case "line": {
        if (
          call.x1 !== undefined &&
          call.y1 !== undefined &&
          call.x2 !== undefined &&
          call.y2 !== undefined
        ) {
          segs.push({ x1: call.x1, y1: call.y1, x2: call.x2, y2: call.y2 });
        }
        break;
      }
      case "circle": {
        if (call.cx !== undefined && call.cy !== undefined) {
          segs.push(
            ...ellipseSegments(
              call.cx,
              call.cy,
              call.rx ?? 0,
              call.ry ?? 0,
            ),
          );
        }
        break;
      }
      // text: skip for pixel comparison
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------
// TS draw calls → line segments
// ---------------------------------------------------------------------------

export function tsCallsToSegments(calls: DrawCall[]): LineSegment[] {
  const segs: LineSegment[] = [];

  for (const call of calls) {
    switch (call.kind) {
      case "polygon": {
        const pts = call.points as Array<{ x: number; y: number }>;
        segs.push(...polylineSegments(pts, true));
        break;
      }
      case "rect": {
        const { x, y, width, height } = call;
        segs.push({ x1: x, y1: y, x2: x + width, y2: y });
        segs.push({ x1: x + width, y1: y, x2: x + width, y2: y + height });
        segs.push({
          x1: x + width,
          y1: y + height,
          x2: x,
          y2: y + height,
        });
        segs.push({ x1: x, y1: y + height, x2: x, y2: y });
        break;
      }
      case "line": {
        segs.push({
          x1: call.x1,
          y1: call.y1,
          x2: call.x2,
          y2: call.y2,
        });
        break;
      }
      case "circle": {
        segs.push(
          ...ellipseSegments(call.cx, call.cy, call.radius, call.radius),
        );
        break;
      }
      case "arc": {
        segs.push(
          ...arcSegments(
            call.cx,
            call.cy,
            call.radius,
            call.startAngle,
            call.endAngle,
          ),
        );
        break;
      }
      case "path": {
        const pts = pathDataToPoints(call.path);
        const hasClose = call.path.operations.some(
          (op) => op.op === "closePath",
        );
        segs.push(...polylineSegments(pts, hasClose));
        break;
      }
      // Ignore: save, restore, setColor, setLineWidth, setFont, setLineDash,
      //         translate, rotate, scale, text, setRawColor
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Bounds & Viewport
// ---------------------------------------------------------------------------

export function segmentBounds(segs: LineSegment[]): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of segs) {
    minX = Math.min(minX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxX = Math.max(maxX, s.x1, s.x2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

const SCALE = 20; // pixels per grid unit
const PADDING = 1.0; // grid units of padding on each side

export function createViewport(bounds: Bounds): Viewport {
  const w = Math.ceil((bounds.maxX - bounds.minX + 2 * PADDING) * SCALE) + 1;
  const h = Math.ceil((bounds.maxY - bounds.minY + 2 * PADDING) * SCALE) + 1;
  return {
    width: w,
    height: h,
    toPixelX: (x) => (x - bounds.minX + PADDING) * SCALE,
    toPixelY: (y) => (y - bounds.minY + PADDING) * SCALE,
  };
}

// ---------------------------------------------------------------------------
// Rendering: segments → bitmap
// ---------------------------------------------------------------------------

export function renderSegments(segs: LineSegment[], vp: Viewport): Bitmap {
  const bmp = new Bitmap(vp.width, vp.height);
  for (const s of segs) {
    rasterLine(
      bmp,
      vp.toPixelX(s.x1),
      vp.toPixelY(s.y1),
      vp.toPixelX(s.x2),
      vp.toPixelY(s.y2),
    );
  }
  return bmp;
}

// ---------------------------------------------------------------------------
// Bitmap comparison — soft Dice with 1-pixel neighborhood tolerance
// ---------------------------------------------------------------------------

function hasNeighbor(bmp: Bitmap, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (bmp.get(x + dx, y + dy)) return true;
    }
  }
  return false;
}

export function compareBitmaps(a: Bitmap, b: Bitmap): CompareResult {
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);

  let litA = 0;
  let litB = 0;
  let matchedA = 0;
  let matchedB = 0;

  // Count lit pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a.get(x, y)) litA++;
      if (b.get(x, y)) litB++;
    }
  }

  // For each lit pixel in A, check neighborhood in B
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a.get(x, y) && hasNeighbor(b, x, y)) matchedA++;
    }
  }

  // For each lit pixel in B, check neighborhood in A
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (b.get(x, y) && hasNeighbor(a, x, y)) matchedB++;
    }
  }

  const total = litA + litB;
  const dice = total === 0 ? 1.0 : (matchedA + matchedB) / total;

  return { dice, litA, litB, matchedA, matchedB };
}

// ---------------------------------------------------------------------------
// Text extraction & comparison
// ---------------------------------------------------------------------------

function parseJavaOrientation(o: string): {
  horizontal: "left" | "center" | "right";
  vertical: "top" | "middle" | "bottom";
} {
  let horizontal: "left" | "center" | "right" = "left";
  let rest = o;

  if (o.startsWith("LEFT")) {
    horizontal = "left";
    rest = o.slice(4);
  } else if (o.startsWith("RIGHT")) {
    horizontal = "right";
    rest = o.slice(5);
  } else if (o.startsWith("CENTER")) {
    horizontal = "center";
    rest = o.slice(6);
  }

  let vertical: "top" | "middle" | "bottom" = "middle";
  if (rest === "TOP") vertical = "top";
  else if (rest === "BOTTOM") vertical = "bottom";
  // CENTER → "middle"

  return { horizontal, vertical };
}

export function extractJavaTexts(calls: JavaDrawCall[]): TextEntry[] {
  const texts: TextEntry[] = [];
  for (const call of calls) {
    if (call.kind !== "text") continue;
    if (call.text === undefined || call.text === "") continue;
    const anchor = parseJavaOrientation(call.orientation ?? "LEFTCENTER");
    texts.push({
      text: call.text,
      x: call.x ?? 0,
      y: call.y ?? 0,
      ...anchor,
    });
  }
  return texts;
}

export function extractTSTexts(calls: DrawCall[]): TextEntry[] {
  const texts: TextEntry[] = [];
  for (const call of calls) {
    if (call.kind !== "text") continue;
    if (call.text === "") continue;
    texts.push({
      text: call.text,
      x: call.x,
      y: call.y,
      horizontal: call.anchor.horizontal,
      vertical: call.anchor.vertical,
    });
  }
  return texts;
}

export function compareExtents(javaBounds: Bounds, tsBounds: Bounds): ExtentResult {
  const javaW = javaBounds.maxX - javaBounds.minX;
  const javaH = javaBounds.maxY - javaBounds.minY;
  const tsW = tsBounds.maxX - tsBounds.minX;
  const tsH = tsBounds.maxY - tsBounds.minY;
  const javaCx = (javaBounds.minX + javaBounds.maxX) / 2;
  const javaCy = (javaBounds.minY + javaBounds.maxY) / 2;
  const tsCx = (tsBounds.minX + tsBounds.maxX) / 2;
  const tsCy = (tsBounds.minY + tsBounds.maxY) / 2;
  const widthDelta = tsW - javaW;
  const heightDelta = tsH - javaH;
  const centerDx = tsCx - javaCx;
  const centerDy = tsCy - javaCy;
  return {
    javaW, javaH, tsW, tsH,
    widthDelta, heightDelta, centerDx, centerDy,
    maxDelta: Math.max(
      Math.abs(widthDelta), Math.abs(heightDelta),
      Math.abs(centerDx), Math.abs(centerDy),
    ),
  };
}

// ---------------------------------------------------------------------------
// Text overlap detection
// ---------------------------------------------------------------------------

export interface TextBox {
  text: string;
  x: number;
  y: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  fontSize: number;
}

export interface TextOverlap {
  a: TextBox;
  b: TextBox;
  overlapArea: number;
}

export interface TextOverlapResult {
  texts: TextBox[];
  overlaps: TextOverlap[];
}

/** Estimate text bounding box from position, anchor, font size, and text length. */
function estimateTextBox(
  text: string,
  x: number,
  y: number,
  anchor: { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" },
  fontSize: number,
): TextBox {
  // Approximate: each character ~0.55× font size wide, height = fontSize
  const w = text.length * fontSize * 0.55;
  const h = fontSize;

  let minX: number, maxX: number;
  switch (anchor.horizontal) {
    case "left":   minX = x; maxX = x + w; break;
    case "center": minX = x - w / 2; maxX = x + w / 2; break;
    case "right":  minX = x - w; maxX = x; break;
  }

  let minY: number, maxY: number;
  switch (anchor.vertical) {
    case "top":    minY = y; maxY = y + h; break;
    case "middle": minY = y - h / 2; maxY = y + h / 2; break;
    case "bottom": minY = y - h; maxY = y; break;
  }

  return { text, x, y, minX, minY, maxX, maxY, fontSize };
}

function boxesOverlap(a: TextBox, b: TextBox): number {
  const ox = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const oy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return ox * oy;
}

/**
 * Extract text calls from TS DrawCall log with font size,
 * then detect pairwise overlaps.
 */
export function detectTextOverlaps(calls: DrawCall[]): TextOverlapResult {
  const texts: TextBox[] = [];
  let currentFontSize = 1.0;

  for (const call of calls) {
    if (call.kind === "setFont") {
      currentFontSize = call.font.size;
    } else if (call.kind === "text" && call.text.length > 0) {
      texts.push(estimateTextBox(call.text, call.x, call.y, call.anchor, currentFontSize));
    }
  }

  const overlaps: TextOverlap[] = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const area = boxesOverlap(texts[i], texts[j]);
      if (area > 0.01) { // threshold: > 0.01 grid² to count as overlap
        overlaps.push({ a: texts[i], b: texts[j], overlapArea: area });
      }
    }
  }

  return { texts, overlaps };
}

export function compareTexts(
  javaTexts: TextEntry[],
  tsTexts: TextEntry[],
): TextCompareResult {
  const jSorted = [...javaTexts].sort((a, b) => a.text.localeCompare(b.text));
  const tSorted = [...tsTexts].sort((a, b) => a.text.localeCompare(b.text));

  const matched: TextCompareResult["matched"] = [];
  const usedJ = new Set<number>();
  const usedT = new Set<number>();

  // Greedy match by text content
  for (let ji = 0; ji < jSorted.length; ji++) {
    for (let ti = 0; ti < tSorted.length; ti++) {
      if (usedT.has(ti)) continue;
      if (jSorted[ji].text === tSorted[ti].text) {
        const dx = jSorted[ji].x - tSorted[ti].x;
        const dy = jSorted[ji].y - tSorted[ti].y;
        matched.push({
          java: jSorted[ji],
          ts: tSorted[ti],
          posDiff: Math.sqrt(dx * dx + dy * dy),
        });
        usedJ.add(ji);
        usedT.add(ti);
        break;
      }
    }
  }

  const missingInTS = jSorted.filter((_, i) => !usedJ.has(i));
  const extraInTS = tSorted.filter((_, i) => !usedT.has(i));

  return { matched, missingInTS, extraInTS };
}

// ---------------------------------------------------------------------------
// Pin-to-body proximity check
// ---------------------------------------------------------------------------

export interface PinProximityResult {
  /** Pins whose minimum distance to any drawn segment exceeds the threshold. */
  detached: Array<{ label: string; x: number; y: number; distance: number }>;
}

/**
 * Minimum distance from a point to a line segment.
 */
function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    // Degenerate segment (point)
    const ex = px - x1;
    const ey = py - y1;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ex = px - projX;
  const ey = py - projY;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Check whether every pin position is within `threshold` grid units of at
 * least one drawn line segment. Catches pins that "float" away from the
 * symbol body (e.g. Function's in1 pin below the rectangle).
 *
 * @param pins      Array of {label, x, y} in local coordinates.
 * @param segments  Line segments from tsCallsToSegments().
 * @param threshold Maximum allowed distance in grid units (default 0.1).
 */
export function checkPinProximity(
  pins: ReadonlyArray<{ label: string; x: number; y: number }>,
  segments: readonly LineSegment[],
  threshold = 0.6,
): PinProximityResult {
  // Text-only components produce no segments — nothing to be "detached from".
  // Skip proximity check when the drawn shape has no geometric content.
  if (segments.length === 0) return { detached: [] };

  const detached: PinProximityResult["detached"] = [];

  for (const pin of pins) {
    let minDist = Infinity;
    for (const seg of segments) {
      const d = pointToSegmentDistance(pin.x, pin.y, seg.x1, seg.y1, seg.x2, seg.y2);
      if (d < minDist) minDist = d;
      if (minDist <= threshold) break; // early exit
    }
    if (minDist > threshold) {
      detached.push({
        label: pin.label,
        x: pin.x,
        y: pin.y,
        distance: Math.round(minDist * 1000) / 1000,
      });
    }
  }

  return { detached };
}
