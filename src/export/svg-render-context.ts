/**
 * SVGRenderContext — SVG implementation of RenderContext.
 *
 * Builds an SVG document as a string by translating RenderContext calls
 * into SVG elements. Transformation state (translate/rotate/scale) is
 * tracked in a matrix stack and emitted as SVG transform attributes.
 *
 * save()/restore() nest <g> elements. Each save() pushes the current
 * transform state. restore() pops it and closes the <g> group.
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

/**
 * A 2D affine transform stored as a 6-element matrix [a,b,c,d,e,f]:
 *   | a  c  e |
 *   | b  d  f |
 *   | 0  0  1 |
 */
interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

function identityMatrix(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function matrixToTransform(m: Matrix): string {
  return `matrix(${fmt(m.a)},${fmt(m.b)},${fmt(m.c)},${fmt(m.d)},${fmt(m.e)},${fmt(m.f)})`;
}

/** Format a number for SVG attributes — trim unnecessary decimals. */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6);
  return s.replace(/\.?0+$/, "");
}

/** Escape text for XML content. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface DrawState {
  color: string;
  lineWidth: number;
  font: FontSpec;
  lineDash: number[];
  transform: Matrix;
}

function defaultDrawState(): DrawState {
  return {
    color: "#000000",
    lineWidth: 1,
    font: { family: "sans-serif", size: 12 },
    lineDash: [],
    transform: identityMatrix(),
  };
}

function cloneDrawState(s: DrawState): DrawState {
  return {
    color: s.color,
    lineWidth: s.lineWidth,
    font: { ...s.font },
    lineDash: [...s.lineDash],
    transform: { ...s.transform },
  };
}

/**
 * Text format for SVG export.
 *
 * - 'plain': text content emitted as-is.
 * - 'latex': negation bars over letters become LaTeX \overline{} notation.
 *   Single-letter labels like /A become $\overline{A}$.
 */
export type TextFormat = "plain" | "latex";

export interface SVGRenderContextOptions {
  /** Color scheme for resolving ThemeColors. */
  scheme: ColorScheme;
  /** Text rendering format. */
  textFormat?: TextFormat;
}

/**
 * SVG implementation of RenderContext.
 *
 * Callers call beginDocument(width, height), issue draw calls, then call
 * finishDocument() to retrieve the SVG string.
 */
export class SVGRenderContext implements RenderContext {
  private _scheme: ColorScheme;
  private _textFormat: TextFormat;

  /** SVG element strings accumulated at current nesting level. */
  private _elements: string[] = [];

  /** State save stack — each save() pushes, restore() pops. */
  private _stateStack: DrawState[] = [];

  /** Current draw state. */
  private _state: DrawState = defaultDrawState();

  constructor(options: SVGRenderContextOptions) {
    this._scheme = options.scheme;
    this._textFormat = options.textFormat ?? "plain";
  }

  // ---------------------------------------------------------------------------
  // Document lifecycle
  // ---------------------------------------------------------------------------

  /** Call before issuing draw calls. Returns this for chaining. */
  beginDocument(): this {
    this._elements = [];
    this._stateStack = [];
    this._state = defaultDrawState();
    return this;
  }

  /**
   * Assemble the complete SVG string.
   *
   * If background is provided, a background rect is prepended.
   */
  finishDocument(
    viewBoxX: number,
    viewBoxY: number,
    viewBoxW: number,
    viewBoxH: number,
    options?: { background?: string },
  ): string {
    const bg = options?.background;
    const bgElement = bg
      ? `<rect x="${fmt(viewBoxX)}" y="${fmt(viewBoxY)}" width="${fmt(viewBoxW)}" height="${fmt(viewBoxH)}" fill="${escapeXml(bg)}"/>\n`
      : "";

    const body = this._elements.join("\n");
    return (
      `<svg xmlns="http://www.w3.org/2000/svg"` +
      ` viewBox="${fmt(viewBoxX)} ${fmt(viewBoxY)} ${fmt(viewBoxW)} ${fmt(viewBoxH)}"` +
      ` width="${fmt(viewBoxW)}" height="${fmt(viewBoxH)}">\n` +
      bgElement +
      body +
      `\n</svg>`
    );
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  save(): void {
    this._stateStack.push(cloneDrawState(this._state));
  }

  restore(): void {
    const prev = this._stateStack.pop();
    if (prev !== undefined) {
      this._state = prev;
    }
  }

  translate(dx: number, dy: number): void {
    const t: Matrix = { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
    this._state.transform = multiplyMatrix(this._state.transform, t);
  }

  rotate(angle: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const r: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
    this._state.transform = multiplyMatrix(this._state.transform, r);
  }

  scale(sx: number, sy: number): void {
    const s: Matrix = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
    this._state.transform = multiplyMatrix(this._state.transform, s);
  }

  setColor(color: ThemeColor): void {
    this._state.color = this._scheme.resolve(color);
  }

  setRawColor(css: string): void {
    this._state.color = css;
  }

  setLineWidth(width: number): void {
    this._state.lineWidth = width;
  }

  setFont(font: FontSpec): void {
    this._state.font = { ...font };
  }

  setLineDash(pattern: number[]): void {
    this._state.lineDash = [...pattern];
  }

  // ---------------------------------------------------------------------------
  // Draw primitives
  // ---------------------------------------------------------------------------

  drawLine(x1: number, y1: number, x2: number, y2: number): void {
    const attrs = this._strokeAttrs();
    const transform = this._transformAttr();
    this._emit(
      `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"${attrs}${transform}/>`,
    );
  }

  drawRect(x: number, y: number, width: number, height: number, filled: boolean): void {
    const attrs = filled ? this._fillAttrs() : this._strokeAttrs();
    const transform = this._transformAttr();
    this._emit(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}"${attrs}${transform}/>`,
    );
  }

  drawCircle(cx: number, cy: number, radius: number, filled: boolean): void {
    const attrs = filled ? this._fillAttrs() : this._strokeAttrs();
    const transform = this._transformAttr();
    this._emit(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}"${attrs}${transform}/>`);
  }

  drawArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): void {
    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);

    let sweep = endAngle - startAngle;
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2;

    const largeArc = sweep > Math.PI ? 1 : 0;

    const attrs = this._strokeAttrs();
    const transform = this._transformAttr();
    this._emit(
      `<path d="M${fmt(x1)},${fmt(y1)} A${fmt(radius)},${fmt(radius)} 0 ${largeArc},1 ${fmt(x2)},${fmt(y2)}"${attrs}${transform}/>`,
    );
  }

  drawPolygon(points: readonly Point[], filled: boolean): void {
    if (points.length === 0) return;
    const pointsStr = points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
    const attrs = filled ? this._fillAttrs() : this._strokeAttrs();
    const transform = this._transformAttr();
    this._emit(`<polygon points="${pointsStr}"${attrs}${transform}/>`);
  }

  drawPath(path: PathData, filled?: boolean): void {
    const d = this._buildPathD(path.operations);
    const attrs = filled ? this._fillAttrs() : this._strokeAttrs();
    const transform = this._transformAttr();
    this._emit(`<path d="${d}"${attrs}${transform}/>`);
  }

  drawText(text: string, x: number, y: number, anchor: TextAnchor): void {
    const content = this._formatText(text);
    const anchorAttr = this._textAnchorAttr(anchor.horizontal);
    const baselineAttr = this._textBaselineAttr(anchor.vertical);
    const fontAttr = this._fontAttr();
    const fillAttr = ` fill="${escapeXml(this._state.color)}"`;
    const transform = this._transformAttr();
    this._emit(
      `<text x="${fmt(x)}" y="${fmt(y)}"${anchorAttr}${baselineAttr}${fontAttr}${fillAttr}${transform}>${content}</text>`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers — attribute builders
  // ---------------------------------------------------------------------------

  private _strokeAttrs(): string {
    const color = escapeXml(this._state.color);
    const dash =
      this._state.lineDash.length > 0
        ? ` stroke-dasharray="${this._state.lineDash.join(",")}"`
        : "";
    return ` stroke="${color}" fill="none" stroke-width="${fmt(this._state.lineWidth)}"${dash}`;
  }

  private _fillAttrs(): string {
    const color = escapeXml(this._state.color);
    return ` fill="${color}" stroke="none"`;
  }

  private _transformAttr(): string {
    const m = this._state.transform;
    const isIdentity =
      m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
    if (isIdentity) return "";
    return ` transform="${matrixToTransform(m)}"`;
  }

  private _fontAttr(): string {
    const f = this._state.font;
    const size = f.size;
    const family = escapeXml(f.family);
    const weight = f.weight ?? "normal";
    const style = f.style ?? "normal";
    return ` font-family="${family}" font-size="${fmt(size)}" font-weight="${weight}" font-style="${style}"`;
  }

  private _textAnchorAttr(h: TextAnchor["horizontal"]): string {
    const map: Record<TextAnchor["horizontal"], string> = {
      left: "start",
      center: "middle",
      right: "end",
    };
    return ` text-anchor="${map[h]}"`;
  }

  private _textBaselineAttr(v: TextAnchor["vertical"]): string {
    const map: Record<TextAnchor["vertical"], string> = {
      top: "hanging",
      middle: "central",
      bottom: "auto",
    };
    return ` dominant-baseline="${map[v]}"`;
  }

  private _buildPathD(ops: readonly PathOperation[]): string {
    const parts: string[] = [];
    for (const op of ops) {
      switch (op.op) {
        case "moveTo":
          parts.push(`M${fmt(op.x)},${fmt(op.y)}`);
          break;
        case "lineTo":
          parts.push(`L${fmt(op.x)},${fmt(op.y)}`);
          break;
        case "curveTo":
          parts.push(
            `C${fmt(op.cp1x)},${fmt(op.cp1y)} ${fmt(op.cp2x)},${fmt(op.cp2y)} ${fmt(op.x)},${fmt(op.y)}`,
          );
          break;
        case "closePath":
          parts.push("Z");
          break;
      }
    }
    return parts.join(" ");
  }

  private _formatText(text: string): string {
    if (this._textFormat === "latex") {
      return this._toLatex(text);
    }
    return escapeXml(text);
  }

  /**
   * Convert negation notation to LaTeX.
   *
   * Leading slash (e.g. "/A") → "$\overline{A}$".
   * Trailing bar (e.g. "A_bar") is not a Digital convention, so only the
   * leading-slash form is handled here.
   */
  private _toLatex(text: string): string {
    if (text.startsWith("/") && text.length > 1) {
      const inner = escapeXml(text.slice(1));
      return `$\\overline{${inner}}$`;
    }
    return escapeXml(text);
  }

  private _emit(element: string): void {
    this._elements.push(element);
  }

  // ---------------------------------------------------------------------------
  // Accessors for tests / export layer
  // ---------------------------------------------------------------------------

  /** All SVG element strings emitted so far (before finishDocument). */
  get elements(): readonly string[] {
    return this._elements;
  }

  /** Current color as a CSS string (resolved from scheme). */
  get currentColor(): string {
    return this._state.color;
  }
}
