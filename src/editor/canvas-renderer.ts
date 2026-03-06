/**
 * Canvas 2D implementation of RenderContext.
 *
 * All drawing primitives delegate to CanvasRenderingContext2D. Colors are
 * resolved through a ColorScheme so callers only name semantic ThemeColors.
 * Theme switching is supported at runtime via setColorScheme().
 */

import type {
  RenderContext,
  Point,
  PathData,
  PathOperation,
  TextAnchor,
  ThemeColor,
  FontSpec,
  ColorScheme,
} from "@/core/renderer-interface";

export class CanvasRenderer implements RenderContext {
  private _ctx: CanvasRenderingContext2D;
  private _scheme: ColorScheme;
  /**
   * Inverse of the current canvas grid scale. Line widths passed to
   * setLineWidth() are in pixels; this factor converts them to the
   * scaled coordinate space so a width of 1 always renders as ~1 screen pixel.
   */
  private _lineWidthScale: number = 1;

  constructor(ctx: CanvasRenderingContext2D, scheme: ColorScheme) {
    this._ctx = ctx;
    this._scheme = scheme;
  }

  /**
   * Set the current grid scale so that setLineWidth() can compensate.
   * Call this after applying the world→screen transform (zoom * GRID_SPACING).
   */
  setGridScale(scale: number): void {
    this._lineWidthScale = scale > 0 ? 1 / scale : 1;
  }

  setColorScheme(scheme: ColorScheme): void {
    this._scheme = scheme;
  }

  drawLine(x1: number, y1: number, x2: number, y2: number): void {
    this._ctx.beginPath();
    this._ctx.moveTo(x1, y1);
    this._ctx.lineTo(x2, y2);
    this._ctx.stroke();
  }

  drawRect(x: number, y: number, width: number, height: number, filled: boolean): void {
    if (filled) {
      this._ctx.fillRect(x, y, width, height);
    } else {
      this._ctx.strokeRect(x, y, width, height);
    }
  }

  drawCircle(cx: number, cy: number, radius: number, filled: boolean): void {
    this._ctx.beginPath();
    this._ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    if (filled) {
      this._ctx.fill();
    } else {
      this._ctx.stroke();
    }
  }

  drawArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): void {
    this._ctx.beginPath();
    this._ctx.arc(cx, cy, radius, startAngle, endAngle);
    this._ctx.stroke();
  }

  drawPolygon(points: readonly Point[], filled: boolean): void {
    if (points.length === 0) return;
    this._ctx.beginPath();
    const first = points[0]!;
    this._ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      this._ctx.lineTo(p.x, p.y);
    }
    this._ctx.closePath();
    if (filled) {
      this._ctx.fill();
    } else {
      this._ctx.stroke();
    }
  }

  drawPath(path: PathData, filled?: boolean): void {
    this._ctx.beginPath();
    for (const op of path.operations) {
      this._applyPathOperation(op);
    }
    if (filled) { this._ctx.fill(); } else { this._ctx.stroke(); }
  }

  private _applyPathOperation(op: PathOperation): void {
    switch (op.op) {
      case "moveTo":
        this._ctx.moveTo(op.x, op.y);
        break;
      case "lineTo":
        this._ctx.lineTo(op.x, op.y);
        break;
      case "curveTo":
        this._ctx.bezierCurveTo(op.cp1x, op.cp1y, op.cp2x, op.cp2y, op.x, op.y);
        break;
      case "closePath":
        this._ctx.closePath();
        break;
    }
  }

  drawText(text: string, x: number, y: number, anchor: TextAnchor): void {
    this._ctx.textAlign = this._mapHorizontalAnchor(anchor.horizontal);
    this._ctx.textBaseline = this._mapVerticalAnchor(anchor.vertical);
    this._ctx.fillText(text, x, y);
  }

  private _mapHorizontalAnchor(h: TextAnchor["horizontal"]): CanvasTextAlign {
    switch (h) {
      case "left": return "left";
      case "center": return "center";
      case "right": return "right";
    }
  }

  private _mapVerticalAnchor(v: TextAnchor["vertical"]): CanvasTextBaseline {
    switch (v) {
      case "top": return "top";
      case "middle": return "middle";
      case "bottom": return "bottom";
    }
  }

  save(): void {
    this._ctx.save();
  }

  restore(): void {
    this._ctx.restore();
  }

  translate(dx: number, dy: number): void {
    this._ctx.translate(dx, dy);
  }

  rotate(angle: number): void {
    this._ctx.rotate(angle);
  }

  scale(sx: number, sy: number): void {
    this._ctx.scale(sx, sy);
  }

  setColor(color: ThemeColor): void {
    const css = this._scheme.resolve(color);
    this._ctx.strokeStyle = css;
    this._ctx.fillStyle = css;
  }

  setLineWidth(width: number): void {
    this._ctx.lineWidth = width * this._lineWidthScale;
  }

  setFont(font: FontSpec): void {
    const weight = font.weight ?? "normal";
    const style = font.style ?? "normal";
    this._ctx.font = `${style} ${weight} ${font.size}px ${font.family}`;
  }

  setLineDash(pattern: number[]): void {
    this._ctx.setLineDash(pattern);
  }
}
