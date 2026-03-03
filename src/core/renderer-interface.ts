/**
 * Renderer interface — engine-agnostic drawing context.
 *
 * Components call these methods to render themselves. The concrete
 * implementation may be Canvas2D, SVG, or a test recorder. No component
 * code imports anything except this interface and the types below.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Transform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export type ThemeColor =
  | "WIRE"
  | "WIRE_HIGH"
  | "WIRE_LOW"
  | "WIRE_Z"
  | "WIRE_UNDEFINED"
  | "COMPONENT"
  | "COMPONENT_FILL"
  | "PIN"
  | "TEXT"
  | "GRID"
  | "BACKGROUND"
  | "SELECTION";

export interface ColorScheme {
  resolve(color: ThemeColor): string;
}

export interface FontSpec {
  family: string;
  size: number;
  weight?: "normal" | "bold";
  style?: "normal" | "italic";
}

export interface TextAnchor {
  horizontal: "left" | "center" | "right";
  vertical: "top" | "middle" | "bottom";
}

export type PathOperation =
  | { op: "moveTo"; x: number; y: number }
  | { op: "lineTo"; x: number; y: number }
  | { op: "curveTo"; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }
  | { op: "closePath" };

export interface PathData {
  operations: PathOperation[];
}

export interface RenderContext {
  drawLine(x1: number, y1: number, x2: number, y2: number): void;
  drawRect(x: number, y: number, width: number, height: number, filled: boolean): void;
  drawCircle(cx: number, cy: number, radius: number, filled: boolean): void;
  drawArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): void;
  drawPolygon(points: readonly Point[], filled: boolean): void;
  drawPath(path: PathData): void;
  drawText(text: string, x: number, y: number, anchor: TextAnchor): void;

  save(): void;
  restore(): void;
  translate(dx: number, dy: number): void;
  rotate(angle: number): void;
  scale(sx: number, sy: number): void;

  setColor(color: ThemeColor): void;
  setLineWidth(width: number): void;
  setFont(font: FontSpec): void;
  setLineDash(pattern: number[]): void;
}
