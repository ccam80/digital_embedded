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
  | "WIRE_ERROR"
  | "WIRE_UNDEFINED"
  | "WIRE_ANALOG"
  | "WIRE_VOLTAGE_POS"
  | "WIRE_VOLTAGE_NEG"
  | "WIRE_VOLTAGE_GND"
  | "CURRENT_DOT"
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

/** A color stop within a linear gradient. */
export interface GradientStop {
  /** Position along the gradient axis, in [0, 1]. */
  offset: number;
  /** CSS color string (e.g. `rgb(r, g, b)` or `#rrggbb`). */
  color: string;
}

export interface RenderContext {
  drawLine(x1: number, y1: number, x2: number, y2: number): void;
  drawRect(x: number, y: number, width: number, height: number, filled: boolean): void;
  drawCircle(cx: number, cy: number, radius: number, filled: boolean): void;
  drawArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): void;
  drawPolygon(points: readonly Point[], filled: boolean): void;
  drawPath(path: PathData, filled?: boolean): void;
  drawText(text: string, x: number, y: number, anchor: TextAnchor): void;

  save(): void;
  restore(): void;
  translate(dx: number, dy: number): void;
  rotate(angle: number): void;
  scale(sx: number, sy: number): void;

  setColor(color: ThemeColor): void;
  setRawColor?(css: string): void;
  /**
   * Set the stroke and fill to a linear gradient in local coordinates.
   * Subsequent drawLine/drawPath/drawArc calls use this gradient as their
   * stroke style. The gradient is defined along the axis (x1,y1)→(x2,y2)
   * with the given color stops. Optional — renderers that don't support
   * gradients may omit this method.
   */
  setLinearGradient?(
    x1: number, y1: number, x2: number, y2: number,
    stops: readonly GradientStop[],
  ): void;
  setLineWidth(width: number): void;
  setFont(font: FontSpec): void;
  setLineDash(pattern: number[]): void;
}

type ColorMap = Record<ThemeColor, string>;

function makeScheme(map: ColorMap): ColorScheme {
  return {
    resolve(color: ThemeColor): string {
      return map[color];
    },
  };
}

const LIGHT_COLORS: ColorMap = {
  WIRE: "#000000",
  WIRE_HIGH: "#00bb00",
  WIRE_LOW: "#006600",
  WIRE_Z: "#aaaaaa",
  WIRE_ERROR: "#ff0000",
  WIRE_UNDEFINED: "#ff4444",
  WIRE_ANALOG: "#2266cc",
  WIRE_VOLTAGE_POS: "#008800",
  WIRE_VOLTAGE_NEG: "#cc0000",
  WIRE_VOLTAGE_GND: "#666666",
  CURRENT_DOT: "#cc9900",
  COMPONENT: "#000000",
  COMPONENT_FILL: "#ffffff",
  PIN: "#0000cc",
  TEXT: "#000000",
  GRID: "#eeeeee",
  BACKGROUND: "#f8f8f8",
  SELECTION: "#0066cc",
};

const DARK_COLORS: ColorMap = {
  WIRE: "#888888",
  WIRE_HIGH: "#00ff00",
  WIRE_LOW: "#00aa00",
  WIRE_Z: "#4444ff",
  WIRE_ERROR: "#ff0000",
  WIRE_UNDEFINED: "#ff8800",
  WIRE_ANALOG: "#4488ff",
  WIRE_VOLTAGE_POS: "#44cc44",
  WIRE_VOLTAGE_NEG: "#ff4444",
  WIRE_VOLTAGE_GND: "#888888",
  CURRENT_DOT: "#ffcc00",
  COMPONENT: "#cccccc",
  COMPONENT_FILL: "#333333",
  PIN: "#4444ff",
  TEXT: "#ffffff",
  GRID: "#2d2d2d",
  BACKGROUND: "#000000",
  SELECTION: "#ffff00",
};

const HIGH_CONTRAST_COLORS: ColorMap = {
  WIRE: "#ffffff",
  WIRE_HIGH: "#00ff00",
  WIRE_LOW: "#007700",
  WIRE_Z: "#cccccc",
  WIRE_ERROR: "#ff0000",
  WIRE_UNDEFINED: "#ff4444",
  WIRE_ANALOG: "#66aaff",
  WIRE_VOLTAGE_POS: "#00ff00",
  WIRE_VOLTAGE_NEG: "#ff0000",
  WIRE_VOLTAGE_GND: "#ffffff",
  CURRENT_DOT: "#ffff00",
  COMPONENT: "#ffffff",
  COMPONENT_FILL: "#000000",
  PIN: "#4488ff",
  TEXT: "#ffffff",
  GRID: "#333333",
  BACKGROUND: "#000000",
  SELECTION: "#ffff00",
};

const MONOCHROME_COLORS: ColorMap = {
  WIRE: "#000000",
  WIRE_HIGH: "#000000",
  WIRE_LOW: "#888888",
  WIRE_Z: "#888888",
  WIRE_ERROR: "#444444",
  WIRE_UNDEFINED: "#444444",
  WIRE_ANALOG: "#000000",
  WIRE_VOLTAGE_POS: "#ffffff",
  WIRE_VOLTAGE_NEG: "#aaaaaa",
  WIRE_VOLTAGE_GND: "#666666",
  CURRENT_DOT: "#888888",
  COMPONENT: "#000000",
  COMPONENT_FILL: "#ffffff",
  PIN: "#000000",
  TEXT: "#000000",
  GRID: "#cccccc",
  BACKGROUND: "#ffffff",
  SELECTION: "#000000",
};

export const lightColorScheme: ColorScheme = makeScheme(LIGHT_COLORS);
export const darkColorScheme: ColorScheme = makeScheme(DARK_COLORS);
export const highContrastColorScheme: ColorScheme = makeScheme(HIGH_CONTRAST_COLORS);
export const monochromeColorScheme: ColorScheme = makeScheme(MONOCHROME_COLORS);

export const defaultColorScheme: ColorScheme = darkColorScheme;

/** All available built-in color schemes, keyed by name. */
export const COLOR_SCHEMES: Record<string, ColorScheme> = {
  default: defaultColorScheme,
  dark: darkColorScheme,
  light: lightColorScheme,
  "high-contrast": highContrastColorScheme,
  monochrome: monochromeColorScheme,
};

/** All ThemeColor values as a readonly array, useful for exhaustiveness checks and tests. */
export const THEME_COLORS: readonly ThemeColor[] = [
  "WIRE",
  "WIRE_HIGH",
  "WIRE_LOW",
  "WIRE_Z",
  "WIRE_ERROR",
  "WIRE_UNDEFINED",
  "WIRE_ANALOG",
  "WIRE_VOLTAGE_POS",
  "WIRE_VOLTAGE_NEG",
  "WIRE_VOLTAGE_GND",
  "CURRENT_DOT",
  "COMPONENT",
  "COMPONENT_FILL",
  "PIN",
  "TEXT",
  "GRID",
  "BACKGROUND",
  "SELECTION",
] as const;
