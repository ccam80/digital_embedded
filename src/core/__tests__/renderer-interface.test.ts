/**
 * Unit tests for the renderer interface types and built-in color schemes.
 *
 * Verifies that:
 * - All ThemeColor values are present in THEME_COLORS
 * - All three built-in ColorScheme implementations resolve every ThemeColor to a non-empty string
 * - ColorScheme implementations are runtime-switchable
 * - RenderContext method signatures are callable via the MockRenderContext
 * - PathData and PathOperation discriminated union is well-formed
 * - TextAnchor values are correctly typed
 */

import { describe, it, expect } from "vitest";
import {
  THEME_COLORS,
  defaultColorScheme,
  highContrastColorScheme,
  monochromeColorScheme,
  COLOR_SCHEMES,
} from "@/core/renderer-interface";
import type {
  ThemeColor,
  ColorScheme,
  FontSpec,
  TextAnchor,
  PathData,
  PathOperation,
  Point,
} from "@/core/renderer-interface";
import { MockRenderContext } from "@/test-utils/mock-render-context";

// ---------------------------------------------------------------------------
// ThemeColor completeness
// ---------------------------------------------------------------------------

describe("THEME_COLORS", () => {
  it("contains all required semantic color names", () => {
    const required: ThemeColor[] = [
      "WIRE",
      "WIRE_HIGH",
      "WIRE_LOW",
      "WIRE_Z",
      "WIRE_UNDEFINED",
      "COMPONENT",
      "COMPONENT_FILL",
      "PIN",
      "TEXT",
      "GRID",
      "BACKGROUND",
      "SELECTION",
    ];
    for (const color of required) {
      expect(THEME_COLORS).toContain(color);
    }
  });

  it("has exactly 12 entries", () => {
    expect(THEME_COLORS).toHaveLength(12);
  });

  it("contains no duplicates", () => {
    const set = new Set(THEME_COLORS);
    expect(set.size).toBe(THEME_COLORS.length);
  });
});

// ---------------------------------------------------------------------------
// Built-in ColorScheme implementations
// ---------------------------------------------------------------------------

describe("defaultColorScheme", () => {
  it("resolves every ThemeColor to a non-empty CSS color string", () => {
    for (const color of THEME_COLORS) {
      const resolved = defaultColorScheme.resolve(color);
      expect(typeof resolved).toBe("string");
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("resolve returns a string starting with '#' for all colors", () => {
    for (const color of THEME_COLORS) {
      expect(defaultColorScheme.resolve(color)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("WIRE_HIGH and WIRE_LOW are different colors", () => {
    expect(defaultColorScheme.resolve("WIRE_HIGH")).not.toBe(
      defaultColorScheme.resolve("WIRE_LOW")
    );
  });

  it("BACKGROUND is light (not black)", () => {
    const bg = defaultColorScheme.resolve("BACKGROUND");
    expect(bg).not.toBe("#000000");
  });
});

describe("highContrastColorScheme", () => {
  it("resolves every ThemeColor to a non-empty CSS color string", () => {
    for (const color of THEME_COLORS) {
      const resolved = highContrastColorScheme.resolve(color);
      expect(typeof resolved).toBe("string");
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("resolve returns a string starting with '#' for all colors", () => {
    for (const color of THEME_COLORS) {
      expect(highContrastColorScheme.resolve(color)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("BACKGROUND is dark (black or near-black)", () => {
    expect(highContrastColorScheme.resolve("BACKGROUND")).toBe("#000000");
  });

  it("WIRE_HIGH is a vivid green", () => {
    expect(highContrastColorScheme.resolve("WIRE_HIGH")).toBe("#00ff00");
  });
});

describe("monochromeColorScheme", () => {
  it("resolves every ThemeColor to a non-empty CSS color string", () => {
    for (const color of THEME_COLORS) {
      const resolved = monochromeColorScheme.resolve(color);
      expect(typeof resolved).toBe("string");
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("resolve returns a string starting with '#' for all colors", () => {
    for (const color of THEME_COLORS) {
      expect(monochromeColorScheme.resolve(color)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("uses only greyscale colors (R == G == B)", () => {
    for (const color of THEME_COLORS) {
      const hex = monochromeColorScheme.resolve(color);
      const r = hex.slice(1, 3);
      const g = hex.slice(3, 5);
      const b = hex.slice(5, 7);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });
});

// ---------------------------------------------------------------------------
// COLOR_SCHEMES registry
// ---------------------------------------------------------------------------

describe("COLOR_SCHEMES", () => {
  it("contains 'default', 'high-contrast', and 'monochrome' keys", () => {
    expect(Object.keys(COLOR_SCHEMES)).toContain("default");
    expect(Object.keys(COLOR_SCHEMES)).toContain("high-contrast");
    expect(Object.keys(COLOR_SCHEMES)).toContain("monochrome");
  });

  it("schemes are switchable at runtime — resolving same color through different schemes gives different results", () => {
    const schemes: ColorScheme[] = [
      COLOR_SCHEMES["default"]!,
      COLOR_SCHEMES["high-contrast"]!,
      COLOR_SCHEMES["monochrome"]!,
    ];
    for (const scheme of schemes) {
      expect(typeof scheme.resolve("WIRE")).toBe("string");
    }
    const results = schemes.map((s) => s.resolve("BACKGROUND"));
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("each scheme in COLOR_SCHEMES resolves all ThemeColors without throwing", () => {
    for (const [, scheme] of Object.entries(COLOR_SCHEMES)) {
      for (const color of THEME_COLORS) {
        expect(() => scheme.resolve(color)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// RenderContext method signatures (via MockRenderContext)
// ---------------------------------------------------------------------------

describe("RenderContext interface method signatures", () => {
  it("drawLine is callable with four numbers", () => {
    const ctx = new MockRenderContext();
    expect(() => ctx.drawLine(0, 0, 100, 100)).not.toThrow();
  });

  it("drawRect is callable with four numbers and a boolean", () => {
    const ctx = new MockRenderContext();
    expect(() => ctx.drawRect(10, 20, 50, 60, true)).not.toThrow();
    expect(() => ctx.drawRect(10, 20, 50, 60, false)).not.toThrow();
  });

  it("drawCircle is callable with cx, cy, radius, filled", () => {
    const ctx = new MockRenderContext();
    expect(() => ctx.drawCircle(5, 5, 10, true)).not.toThrow();
  });

  it("drawArc is callable with cx, cy, radius, startAngle, endAngle", () => {
    const ctx = new MockRenderContext();
    expect(() => ctx.drawArc(0, 0, 20, 0, Math.PI)).not.toThrow();
  });

  it("drawPolygon is callable with readonly Point array and boolean", () => {
    const ctx = new MockRenderContext();
    const points: readonly Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }];
    expect(() => ctx.drawPolygon(points, false)).not.toThrow();
  });

  it("drawPath is callable with PathData", () => {
    const ctx = new MockRenderContext();
    const path: PathData = {
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: 10, y: 10 },
        { op: "closePath" },
      ],
    };
    expect(() => ctx.drawPath(path)).not.toThrow();
  });

  it("drawText is callable with string, x, y, TextAnchor", () => {
    const ctx = new MockRenderContext();
    const anchor: TextAnchor = { horizontal: "center", vertical: "middle" };
    expect(() => ctx.drawText("test", 5, 5, anchor)).not.toThrow();
  });

  it("save and restore are callable", () => {
    const ctx = new MockRenderContext();
    expect(() => { ctx.save(); ctx.restore(); }).not.toThrow();
  });

  it("translate, rotate, scale are callable", () => {
    const ctx = new MockRenderContext();
    expect(() => ctx.translate(10, 20)).not.toThrow();
    expect(() => ctx.rotate(Math.PI / 4)).not.toThrow();
    expect(() => ctx.scale(2, 3)).not.toThrow();
  });

  it("setColor is callable with any ThemeColor", () => {
    const ctx = new MockRenderContext();
    for (const color of THEME_COLORS) {
      expect(() => ctx.setColor(color)).not.toThrow();
    }
  });

  it("setLineWidth is callable with a number", () => {
    const ctx = new MockRenderContext();
    expect(() => ctx.setLineWidth(2)).not.toThrow();
  });

  it("setFont is callable with a FontSpec", () => {
    const ctx = new MockRenderContext();
    const font: FontSpec = { family: "monospace", size: 14, weight: "bold", style: "italic" };
    expect(() => ctx.setFont(font)).not.toThrow();
  });

  it("setLineDash is callable with a number array", () => {
    const ctx = new MockRenderContext();
    expect(() => ctx.setLineDash([4, 2])).not.toThrow();
    expect(() => ctx.setLineDash([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PathOperation discriminated union
// ---------------------------------------------------------------------------

describe("PathOperation discriminated union", () => {
  it("moveTo operation has op, x, y", () => {
    const op: PathOperation = { op: "moveTo", x: 1, y: 2 };
    expect(op.op).toBe("moveTo");
    expect(op.x).toBe(1);
    expect(op.y).toBe(2);
  });

  it("lineTo operation has op, x, y", () => {
    const op: PathOperation = { op: "lineTo", x: 3, y: 4 };
    expect(op.op).toBe("lineTo");
  });

  it("curveTo operation has op, cp1x, cp1y, cp2x, cp2y, x, y", () => {
    const op: PathOperation = { op: "curveTo", cp1x: 1, cp1y: 2, cp2x: 3, cp2y: 4, x: 5, y: 6 };
    expect(op.op).toBe("curveTo");
    expect(op.cp1x).toBe(1);
    expect(op.cp2y).toBe(4);
  });

  it("closePath operation has only op", () => {
    const op: PathOperation = { op: "closePath" };
    expect(op.op).toBe("closePath");
  });

  it("PathData with multiple operations is well-formed", () => {
    const path: PathData = {
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: 10, y: 0 },
        { op: "curveTo", cp1x: 12, cp1y: 0, cp2x: 15, cp2y: 5, x: 15, y: 10 },
        { op: "closePath" },
      ],
    };
    expect(path.operations).toHaveLength(4);
    expect(path.operations[0]?.op).toBe("moveTo");
    expect(path.operations[3]?.op).toBe("closePath");
  });
});

// ---------------------------------------------------------------------------
// TextAnchor type
// ---------------------------------------------------------------------------

describe("TextAnchor", () => {
  it("accepts all horizontal alignment values", () => {
    const left: TextAnchor = { horizontal: "left", vertical: "top" };
    const center: TextAnchor = { horizontal: "center", vertical: "middle" };
    const right: TextAnchor = { horizontal: "right", vertical: "bottom" };
    expect(left.horizontal).toBe("left");
    expect(center.horizontal).toBe("center");
    expect(right.horizontal).toBe("right");
  });

  it("accepts all vertical alignment values", () => {
    const top: TextAnchor = { horizontal: "left", vertical: "top" };
    const middle: TextAnchor = { horizontal: "left", vertical: "middle" };
    const bottom: TextAnchor = { horizontal: "left", vertical: "bottom" };
    expect(top.vertical).toBe("top");
    expect(middle.vertical).toBe("middle");
    expect(bottom.vertical).toBe("bottom");
  });
});

// ---------------------------------------------------------------------------
// FontSpec type
// ---------------------------------------------------------------------------

describe("FontSpec", () => {
  it("requires family and size, with optional weight and style", () => {
    const minimal: FontSpec = { family: "sans-serif", size: 12 };
    expect(minimal.family).toBe("sans-serif");
    expect(minimal.size).toBe(12);
    expect(minimal.weight).toBeUndefined();
    expect(minimal.style).toBeUndefined();
  });

  it("accepts bold weight", () => {
    const bold: FontSpec = { family: "serif", size: 16, weight: "bold" };
    expect(bold.weight).toBe("bold");
  });

  it("accepts italic style", () => {
    const italic: FontSpec = { family: "monospace", size: 10, style: "italic" };
    expect(italic.style).toBe("italic");
  });
});
