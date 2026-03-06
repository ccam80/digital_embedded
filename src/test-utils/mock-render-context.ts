/**
 * Mock RenderContext for unit tests.
 *
 * Records every draw call into a typed log. Tests assert on the log entries
 * rather than on pixel output. Also tracks current style state so tests can
 * assert that a component set the expected color, lineWidth, or font before
 * drawing a shape.
 */

import type {
  RenderContext,
  Point,
  PathData,
  TextAnchor,
  ThemeColor,
  FontSpec,
} from "@/core/renderer-interface";

export type DrawCall =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number; filled: boolean }
  | { kind: "circle"; cx: number; cy: number; radius: number; filled: boolean }
  | { kind: "arc"; cx: number; cy: number; radius: number; startAngle: number; endAngle: number }
  | { kind: "polygon"; points: readonly Point[]; filled: boolean }
  | { kind: "path"; path: PathData }
  | { kind: "text"; text: string; x: number; y: number; anchor: TextAnchor }
  | { kind: "save" }
  | { kind: "restore" }
  | { kind: "translate"; dx: number; dy: number }
  | { kind: "rotate"; angle: number }
  | { kind: "scale"; sx: number; sy: number }
  | { kind: "setColor"; color: ThemeColor }
  | { kind: "setLineWidth"; width: number }
  | { kind: "setFont"; font: FontSpec }
  | { kind: "setLineDash"; pattern: number[] };

export interface StyleState {
  color: ThemeColor;
  lineWidth: number;
  font: FontSpec;
  lineDash: number[];
}

export class MockRenderContext implements RenderContext {
  readonly calls: DrawCall[] = [];

  private _style: StyleState = {
    color: "COMPONENT",
    lineWidth: 1,
    font: { family: "sans-serif", size: 12 },
    lineDash: [],
  };

  private readonly _styleStack: StyleState[] = [];

  get style(): Readonly<StyleState> {
    return this._style;
  }

  drawLine(x1: number, y1: number, x2: number, y2: number): void {
    this.calls.push({ kind: "line", x1, y1, x2, y2 });
  }

  drawRect(x: number, y: number, width: number, height: number, filled: boolean): void {
    this.calls.push({ kind: "rect", x, y, width, height, filled });
  }

  drawCircle(cx: number, cy: number, radius: number, filled: boolean): void {
    this.calls.push({ kind: "circle", cx, cy, radius, filled });
  }

  drawArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): void {
    this.calls.push({ kind: "arc", cx, cy, radius, startAngle, endAngle });
  }

  drawPolygon(points: readonly Point[], filled: boolean): void {
    this.calls.push({ kind: "polygon", points, filled });
  }

  drawPath(path: PathData): void {
    this.calls.push({ kind: "path", path });
  }

  drawText(text: string, x: number, y: number, anchor: TextAnchor): void {
    this.calls.push({ kind: "text", text, x, y, anchor });
  }

  save(): void {
    this._styleStack.push({ ...this._style, lineDash: [...this._style.lineDash] });
    this.calls.push({ kind: "save" });
  }

  restore(): void {
    const saved = this._styleStack.pop();
    if (saved !== undefined) {
      this._style = saved;
    }
    this.calls.push({ kind: "restore" });
  }

  translate(dx: number, dy: number): void {
    this.calls.push({ kind: "translate", dx, dy });
  }

  rotate(angle: number): void {
    this.calls.push({ kind: "rotate", angle });
  }

  scale(sx: number, sy: number): void {
    this.calls.push({ kind: "scale", sx, sy });
  }

  setColor(color: ThemeColor): void {
    this._style = { ...this._style, color };
    this.calls.push({ kind: "setColor", color });
  }

  setLineWidth(width: number): void {
    this._style = { ...this._style, lineWidth: width };
    this.calls.push({ kind: "setLineWidth", width });
  }

  setFont(font: FontSpec): void {
    this._style = { ...this._style, font };
    this.calls.push({ kind: "setFont", font });
  }

  setLineDash(pattern: number[]): void {
    this._style = { ...this._style, lineDash: [...pattern] };
    this.calls.push({ kind: "setLineDash", pattern });
  }

  /** Return only calls of a specific kind for focused assertions. */
  callsOfKind<K extends DrawCall["kind"]>(kind: K): Extract<DrawCall, { kind: K }>[] {
    return this.calls.filter((c): c is Extract<DrawCall, { kind: K }> => c.kind === kind);
  }

  /** Reset the call log and style state. */
  reset(): void {
    this.calls.length = 0;
    this._styleStack.length = 0;
    this._style = {
      color: "COMPONENT",
      lineWidth: 1,
      font: { family: "sans-serif", size: 12 },
      lineDash: [],
    };
  }
}
