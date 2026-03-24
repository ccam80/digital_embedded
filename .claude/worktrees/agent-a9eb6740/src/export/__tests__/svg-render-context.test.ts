/**
 * Tests for SVGRenderContext — verifies RenderContext path calls produce
 * correct SVG `d` attribute strings and that theme colors map to correct
 * SVG fill/stroke values.
 */

import { describe, it, expect } from "vitest";
import { SVGRenderContext } from "../svg-render-context";
import { lightColorScheme } from "@/core/renderer-interface";
import type { PathData } from "@/core/renderer-interface";

function makeCtx(): SVGRenderContext {
  return new SVGRenderContext({ scheme: lightColorScheme });
}

describe("SVGRenderContext", () => {
  describe("pathMapping", () => {
    it("moveTo operation produces M command in path d attribute", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      const path: PathData = {
        operations: [{ op: "moveTo", x: 10, y: 20 }],
      };
      ctx.drawPath(path);
      const elements = ctx.elements;
      expect(elements.length).toBe(1);
      expect(elements[0]).toContain('d="M10,20"');
    });

    it("lineTo operation produces L command in path d attribute", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      const path: PathData = {
        operations: [
          { op: "moveTo", x: 0, y: 0 },
          { op: "lineTo", x: 5, y: 7 },
        ],
      };
      ctx.drawPath(path);
      const el = ctx.elements[0]!;
      expect(el).toContain("M0,0");
      expect(el).toContain("L5,7");
    });

    it("curveTo operation produces C command in path d attribute", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      const path: PathData = {
        operations: [
          { op: "moveTo", x: 0, y: 0 },
          { op: "curveTo", cp1x: 1, cp1y: 2, cp2x: 3, cp2y: 4, x: 5, y: 6 },
        ],
      };
      ctx.drawPath(path);
      const el = ctx.elements[0]!;
      expect(el).toContain("C1,2 3,4 5,6");
    });

    it("closePath operation produces Z command in path d attribute", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      const path: PathData = {
        operations: [
          { op: "moveTo", x: 0, y: 0 },
          { op: "lineTo", x: 10, y: 0 },
          { op: "closePath" },
        ],
      };
      ctx.drawPath(path);
      const el = ctx.elements[0]!;
      expect(el).toContain("Z");
    });

    it("complex path produces all operations in sequence", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      const path: PathData = {
        operations: [
          { op: "moveTo", x: 0, y: 0 },
          { op: "lineTo", x: 10, y: 0 },
          { op: "lineTo", x: 10, y: 10 },
          { op: "closePath" },
        ],
      };
      ctx.drawPath(path);
      const el = ctx.elements[0]!;
      expect(el).toContain("M0,0");
      expect(el).toContain("L10,0");
      expect(el).toContain("L10,10");
      expect(el).toContain("Z");
    });
  });

  describe("colorMapping", () => {
    it("WIRE theme color maps to correct SVG stroke value in light scheme", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("WIRE");
      ctx.drawLine(0, 0, 10, 10);
      const el = ctx.elements[0]!;
      // lightColorScheme WIRE = #000000
      expect(el).toContain('stroke="#000000"');
    });

    it("WIRE_HIGH theme color maps to correct SVG stroke value", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("WIRE_HIGH");
      ctx.drawLine(0, 0, 10, 10);
      const el = ctx.elements[0]!;
      // lightColorScheme WIRE_HIGH = #00bb00
      expect(el).toContain('stroke="#00bb00"');
    });

    it("COMPONENT_FILL theme color maps to correct SVG fill value for filled rect", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("COMPONENT_FILL");
      ctx.drawRect(0, 0, 10, 10, true);
      const el = ctx.elements[0]!;
      // lightColorScheme COMPONENT_FILL = #ffffff
      expect(el).toContain('fill="#ffffff"');
    });

    it("TEXT theme color maps to correct fill value for text elements", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("TEXT");
      ctx.drawText("hello", 5, 5, { horizontal: "left", vertical: "top" });
      const el = ctx.elements[0]!;
      // lightColorScheme TEXT = #000000
      expect(el).toContain('fill="#000000"');
    });

    it("PIN theme color maps to correct fill value for filled circle", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("PIN");
      ctx.drawCircle(5, 5, 2, true);
      const el = ctx.elements[0]!;
      // lightColorScheme PIN = #0000cc
      expect(el).toContain('fill="#0000cc"');
    });

    it("currentColor reflects the resolved color after setColor", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("WIRE_ERROR");
      // lightColorScheme WIRE_ERROR = #ff0000
      expect(ctx.currentColor).toBe("#ff0000");
    });
  });

  describe("save/restore", () => {
    it("restore() reverts color set after save()", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("WIRE");
      ctx.save();
      ctx.setColor("PIN");
      expect(ctx.currentColor).toBe("#0000cc");
      ctx.restore();
      expect(ctx.currentColor).toBe("#000000");
    });
  });

  describe("transform", () => {
    it("translate sets transform attribute on emitted elements", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.translate(5, 10);
      ctx.drawLine(0, 0, 1, 1);
      const el = ctx.elements[0]!;
      expect(el).toContain("transform=");
    });

    it("identity transform does not emit transform attribute", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.drawLine(0, 0, 1, 1);
      const el = ctx.elements[0]!;
      expect(el).not.toContain("transform=");
    });
  });

  describe("drawLine", () => {
    it("emits <line> element with correct coordinates", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.drawLine(1, 2, 3, 4);
      const el = ctx.elements[0]!;
      expect(el).toContain("<line");
      expect(el).toContain('x1="1"');
      expect(el).toContain('y1="2"');
      expect(el).toContain('x2="3"');
      expect(el).toContain('y2="4"');
    });
  });

  describe("drawRect", () => {
    it("emits <rect> element for filled rect", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("COMPONENT_FILL");
      ctx.drawRect(2, 3, 40, 20, true);
      const el = ctx.elements[0]!;
      expect(el).toContain("<rect");
      expect(el).toContain('x="2"');
      expect(el).toContain('y="3"');
      expect(el).toContain('width="40"');
      expect(el).toContain('height="20"');
      expect(el).toContain("fill=");
    });

    it("emits <rect> element with stroke for unfilled rect", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.setColor("COMPONENT");
      ctx.drawRect(0, 0, 10, 10, false);
      const el = ctx.elements[0]!;
      expect(el).toContain('stroke=');
      expect(el).toContain('fill="none"');
    });
  });

  describe("drawCircle", () => {
    it("emits <circle> element with correct cx/cy/r", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.drawCircle(5, 7, 3, false);
      const el = ctx.elements[0]!;
      expect(el).toContain("<circle");
      expect(el).toContain('cx="5"');
      expect(el).toContain('cy="7"');
      expect(el).toContain('r="3"');
    });
  });

  describe("drawText", () => {
    it("emits <text> element with correct content", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.drawText("hello", 10, 20, { horizontal: "center", vertical: "middle" });
      const el = ctx.elements[0]!;
      expect(el).toContain("<text");
      expect(el).toContain("hello");
      expect(el).toContain('x="10"');
      expect(el).toContain('y="20"');
    });

    it("latex mode converts /A to overline notation", () => {
      const ctx = new SVGRenderContext({ scheme: lightColorScheme, textFormat: "latex" });
      ctx.beginDocument();
      ctx.drawText("/A", 0, 0, { horizontal: "left", vertical: "top" });
      const el = ctx.elements[0]!;
      expect(el).toContain("\\overline{A}");
    });

    it("plain mode emits text as-is (with XML escaping)", () => {
      const ctx = new SVGRenderContext({ scheme: lightColorScheme, textFormat: "plain" });
      ctx.beginDocument();
      ctx.drawText("A&B", 0, 0, { horizontal: "left", vertical: "top" });
      const el = ctx.elements[0]!;
      expect(el).toContain("A&amp;B");
    });
  });

  describe("finishDocument", () => {
    it("wraps content in <svg> element with correct viewBox", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      const svg = ctx.finishDocument(0, 0, 100, 50);
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox="0 0 100 50"');
      expect(svg).toContain("</svg>");
    });

    it("includes background rect when background option is provided", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      const svg = ctx.finishDocument(0, 0, 100, 50, { background: "#ffffff" });
      expect(svg).toContain("<rect");
      expect(svg).toContain('fill="#ffffff"');
    });

    it("omits background rect when background option is absent", () => {
      const ctx = makeCtx();
      ctx.beginDocument();
      ctx.drawLine(0, 0, 1, 1);
      const svg = ctx.finishDocument(0, 0, 100, 50);
      // No background <rect> element should be present
      expect(svg).not.toContain("<rect");
    });
  });
});
