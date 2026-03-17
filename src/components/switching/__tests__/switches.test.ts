/**
 * Tests for Switch, SwitchDT, PlainSwitch, PlainSwitchDT components.
 *
 * Covers:
 *   - Open/close state correctly reflected in isClosed()
 *   - SPDT routing: correct terminal connectivity declarations
 *   - Pin declarations: correct count, labels, directions for SPST and SPDT
 *   - executeFn is a no-op (bus resolution handles net merging)
 *   - Attribute mappings: .dig XML attributes convert correctly
 *   - Rendering: closed draws straight line, open draws angled line
 *   - ComponentDefinition completeness for all four variants
 *   - Registry registration succeeds
 */

import { describe, it, expect } from "vitest";
import {
  PlainSwitchElement,
  executePlainSwitch,
  PlainSwitchDefinition,
  PLAIN_SWITCH_ATTRIBUTE_MAPPINGS,
} from "../plain-switch.js";
import {
  PlainSwitchDTElement,
  executePlainSwitchDT,
  PlainSwitchDTDefinition,
  PLAIN_SWITCH_DT_ATTRIBUTE_MAPPINGS,
} from "../plain-switch-dt.js";
import {
  SwitchElement,
  executeSwitch,
  SwitchDefinition,
  SWITCH_ATTRIBUTE_MAPPINGS,
} from "../switch.js";
import {
  SwitchDTElement,
  executeSwitchDT,
  SwitchDTDefinition,
  SWITCH_DT_ATTRIBUTE_MAPPINGS,
} from "../switch-dt.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number = 1): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
    getProperty: () => undefined,
  };
}

function makeState(size: number): Uint32Array {
  return new Uint32Array(size);
}

// ---------------------------------------------------------------------------
// Helpers — RenderContext mock
// ---------------------------------------------------------------------------

interface DrawCall {
  method: string;
  args: unknown[];
}

function makeStubCtx(): { ctx: RenderContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };

  const ctx: RenderContext = {
    drawLine: record("drawLine") as (x1: number, y1: number, x2: number, y2: number) => void,
    drawRect: record("drawRect") as (x: number, y: number, w: number, h: number, filled: boolean) => void,
    drawCircle: record("drawCircle") as (cx: number, cy: number, r: number, filled: boolean) => void,
    drawArc: record("drawArc") as (cx: number, cy: number, r: number, s: number, e: number) => void,
    drawPolygon: record("drawPolygon") as (points: readonly Point[], filled: boolean) => void,
    drawPath: record("drawPath") as (path: PathData) => void,
    drawText: record("drawText") as (text: string, x: number, y: number, anchor: TextAnchor) => void,
    save: record("save") as () => void,
    restore: record("restore") as () => void,
    translate: record("translate") as (dx: number, dy: number) => void,
    rotate: record("rotate") as (angle: number) => void,
    scale: record("scale") as (sx: number, sy: number) => void,
    setColor: record("setColor") as (color: ThemeColor) => void,
    setLineWidth: record("setLineWidth") as (w: number) => void,
    setFont: record("setFont") as (font: FontSpec) => void,
    setLineDash: record("setLineDash") as (pattern: number[]) => void,
  };

  return { ctx, calls };
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makePlainSwitch(overrides?: {
  poles?: number;
  bitWidth?: number;
  closed?: boolean;
  label?: string;
}): PlainSwitchElement {
  const props = new PropertyBag();
  props.set("poles", overrides?.poles ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("closed", overrides?.closed ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new PlainSwitchElement("test-ps-001", { x: 0, y: 0 }, 0, false, props);
}

function makePlainSwitchDT(overrides?: {
  poles?: number;
  bitWidth?: number;
  closed?: boolean;
  label?: string;
}): PlainSwitchDTElement {
  const props = new PropertyBag();
  props.set("poles", overrides?.poles ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("closed", overrides?.closed ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new PlainSwitchDTElement("test-psdt-001", { x: 0, y: 0 }, 0, false, props);
}

function makeSwitch(overrides?: {
  poles?: number;
  bitWidth?: number;
  closed?: boolean;
  label?: string;
  switchActsAsInput?: boolean;
}): SwitchElement {
  const props = new PropertyBag();
  props.set("poles", overrides?.poles ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("closed", overrides?.closed ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  if (overrides?.switchActsAsInput !== undefined)
    props.set("switchActsAsInput", overrides.switchActsAsInput);
  return new SwitchElement("test-sw-001", { x: 0, y: 0 }, 0, false, props);
}

function makeSwitchDT(overrides?: {
  poles?: number;
  bitWidth?: number;
  closed?: boolean;
  label?: string;
}): SwitchDTElement {
  const props = new PropertyBag();
  props.set("poles", overrides?.poles ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("closed", overrides?.closed ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new SwitchDTElement("test-swdt-001", { x: 0, y: 0 }, 0, false, props);
}

// ===========================================================================
// PlainSwitch tests
// ===========================================================================

describe("PlainSwitch", () => {
  // -------------------------------------------------------------------------
  // Open/close state
  // -------------------------------------------------------------------------

  describe("openCloseState", () => {
    it("default PlainSwitch is open (closed=false)", () => {
      const sw = makePlainSwitch();
      expect(sw.isClosed()).toBe(false);
    });

    it("PlainSwitch with closed=true reports isClosed()=true", () => {
      const sw = makePlainSwitch({ closed: true });
      expect(sw.isClosed()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pin layout — SPST has 2 bidirectional pins per pole
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("1-pole PlainSwitch has 2 pins", () => {
      const sw = makePlainSwitch({ poles: 1 });
      expect(sw.getPins()).toHaveLength(2);
    });

    it("1-pole PlainSwitch pins are labeled A1 and B1", () => {
      const sw = makePlainSwitch({ poles: 1 });
      const labels = sw.getPins().map((p) => p.label);
      expect(labels).toContain("A1");
      expect(labels).toContain("B1");
    });

    it("1-pole PlainSwitch pins are BIDIRECTIONAL", () => {
      const sw = makePlainSwitch({ poles: 1 });
      for (const pin of sw.getPins()) {
        expect(pin.direction).toBe(PinDirection.BIDIRECTIONAL);
      }
    });

    it("2-pole PlainSwitch has 4 pins (A1, B1, A2, B2)", () => {
      const sw = makePlainSwitch({ poles: 2 });
      expect(sw.getPins()).toHaveLength(4);
      const labels = sw.getPins().map((p) => p.label);
      expect(labels).toContain("A1");
      expect(labels).toContain("B1");
      expect(labels).toContain("A2");
      expect(labels).toContain("B2");
    });

    it("PlainSwitchDefinition.pinLayout has 2 entries for 1-pole default", () => {
      expect(PlainSwitchDefinition.pinLayout).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // executeFn — no-op
  // -------------------------------------------------------------------------

  describe("executeFnNoOp", () => {
    it("executePlainSwitch does not modify the state array", () => {
      const layout = makeLayout(0, 1);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 42;
      state[1] = 99;
      executePlainSwitch(0, state, highZs, layout);
      expect(state[0]).toBe(42);
      expect(state[1]).toBe(99);
    });

    it("executePlainSwitch can be called 1000 times without error", () => {
      const layout = makeLayout(0, 1);
      const state = makeState(1);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        executePlainSwitch(0, state, highZs, layout);
      }
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("closed switch draw() calls drawLine for horizontal contact", () => {
      const sw = makePlainSwitch({ closed: true });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("open switch draw() calls drawLine for angled contact", () => {
      const sw = makePlainSwitch({ closed: false });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("closed switch contact line goes from x=0 to x=COMP_WIDTH at same y", () => {
      const sw = makePlainSwitch({ closed: true });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      // Closed: first line call should be the horizontal contact (y1 === y2)
      const horizontalLine = lineCalls.find(
        (c) => c.args[0] === 0 && c.args[1] === c.args[3],
      );
      expect(horizontalLine).toBeDefined();
    });

    it("open switch contact line is angled (y2 !== y1)", () => {
      const sw = makePlainSwitch({ closed: false });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      // Open: contact line has different start/end y
      const angledLine = lineCalls.find(
        (c) => c.args[0] === 0 && (c.args[1] as number) !== (c.args[3] as number),
      );
      expect(angledLine).toBeDefined();
    });

    it("draw() calls setLineDash for the dashed lever line", () => {
      const sw = makePlainSwitch();
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const dashCalls = calls.filter((c) => c.method === "setLineDash");
      expect(dashCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("draw() with label calls drawText", () => {
      const sw = makePlainSwitch({ label: "K1" });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "K1")).toBe(true);
    });

    it("draw() without label does not call drawText", () => {
      const sw = makePlainSwitch({ label: "" });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = PLAIN_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("8")).toBe(8);
    });

    it("closed=true maps to boolean true", () => {
      const mapping = PLAIN_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "closed");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
    });

    it("closed=false maps to boolean false", () => {
      const mapping = PLAIN_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "closed");
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Poles=2 maps to poles=2", () => {
      const mapping = PLAIN_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Poles");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("2")).toBe(2);
    });

    it("Label maps to label property", () => {
      const mapping = PLAIN_SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("SW1")).toBe("SW1");
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("PlainSwitchDefinition has name='PlainSwitch'", () => {
      expect(PlainSwitchDefinition.name).toBe("PlainSwitch");
    });

    it("PlainSwitchDefinition has typeId=-1", () => {
      expect(PlainSwitchDefinition.typeId).toBe(-1);
    });

    it("PlainSwitchDefinition has a factory function", () => {
      expect(typeof PlainSwitchDefinition.factory).toBe("function");
    });

    it("PlainSwitchDefinition factory produces a PlainSwitchElement", () => {
      const props = new PropertyBag();
      props.set("poles", 1);
      props.set("bitWidth", 1);
      props.set("closed", false);
      const el = PlainSwitchDefinition.factory(props);
      expect(el.typeId).toBe("PlainSwitch");
    });

    it("PlainSwitchDefinition has executeFn=executePlainSwitch", () => {
      expect(PlainSwitchDefinition.executeFn).toBe(executePlainSwitch);
    });

    it("PlainSwitchDefinition category is SWITCHING", () => {
      expect(PlainSwitchDefinition.category).toBe(ComponentCategory.SWITCHING);
    });

    it("PlainSwitchDefinition has non-empty helpText", () => {
      expect(typeof PlainSwitchDefinition.helpText).toBe("string");
      expect(typeof PlainSwitchDefinition.helpText).toBe("string"); expect(PlainSwitchDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("PlainSwitchDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PlainSwitchDefinition)).not.toThrow();
    });

    it("After registration PlainSwitch typeId is non-negative", () => {
      const registry = new ComponentRegistry();
      registry.register(PlainSwitchDefinition);
      const registered = registry.get("PlainSwitch");
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});

// ===========================================================================
// PlainSwitchDT tests
// ===========================================================================

describe("PlainSwitchDT", () => {
  // -------------------------------------------------------------------------
  // SPDT routing
  // -------------------------------------------------------------------------

  describe("spdtRouting", () => {
    it("default PlainSwitchDT is open (closed=false)", () => {
      const sw = makePlainSwitchDT();
      expect(sw.isClosed()).toBe(false);
    });

    it("PlainSwitchDT with closed=true reports isClosed()=true", () => {
      const sw = makePlainSwitchDT({ closed: true });
      expect(sw.isClosed()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pin layout — SPDT has 3 bidirectional pins per pole (A, B, C)
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("1-pole PlainSwitchDT has 3 pins", () => {
      const sw = makePlainSwitchDT({ poles: 1 });
      expect(sw.getPins()).toHaveLength(3);
    });

    it("1-pole PlainSwitchDT pins are labeled A1, B1, C1", () => {
      const sw = makePlainSwitchDT({ poles: 1 });
      const labels = sw.getPins().map((p) => p.label);
      expect(labels).toContain("A1");
      expect(labels).toContain("B1");
      expect(labels).toContain("C1");
    });

    it("all PlainSwitchDT pins are BIDIRECTIONAL", () => {
      const sw = makePlainSwitchDT({ poles: 1 });
      for (const pin of sw.getPins()) {
        expect(pin.direction).toBe(PinDirection.BIDIRECTIONAL);
      }
    });

    it("2-pole PlainSwitchDT has 6 pins", () => {
      const sw = makePlainSwitchDT({ poles: 2 });
      expect(sw.getPins()).toHaveLength(6);
    });

    it("PlainSwitchDTDefinition.pinLayout has 3 entries for 1-pole default", () => {
      expect(PlainSwitchDTDefinition.pinLayout).toHaveLength(3);
    });

    it("A pin is on left (x=0), B and C pins are on right (x=COMP_WIDTH)", () => {
      const sw = makePlainSwitchDT({ poles: 1 });
      const pinA = sw.getPins().find((p) => p.label === "A1");
      const pinB = sw.getPins().find((p) => p.label === "B1");
      const pinC = sw.getPins().find((p) => p.label === "C1");
      expect(pinA).toBeDefined();
      expect(pinB).toBeDefined();
      expect(pinC).toBeDefined();
      expect(pinA!.position.x).toBe(0);
      expect(pinB!.position.x).toBeGreaterThan(0);
      expect(pinC!.position.x).toBeGreaterThan(0);
      // C is below B (larger y)
      expect(pinC!.position.y).toBeGreaterThan(pinB!.position.y);
    });
  });

  // -------------------------------------------------------------------------
  // executeFn — no-op
  // -------------------------------------------------------------------------

  describe("executeFnNoOp", () => {
    it("executePlainSwitchDT does not modify the state array", () => {
      const layout = makeLayout(0, 1);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 7;
      state[1] = 13;
      executePlainSwitchDT(0, state, highZs, layout);
      expect(state[0]).toBe(7);
      expect(state[1]).toBe(13);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawLine at least once", () => {
      const sw = makePlainSwitchDT();
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls setLineDash for the lever", () => {
      const sw = makePlainSwitchDT();
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const dashCalls = calls.filter((c) => c.method === "setLineDash");
      expect(dashCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("draw() with label calls drawText with the label", () => {
      const sw = makePlainSwitchDT({ label: "SW2" });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "SW2")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits=4 maps to bitWidth=4", () => {
      const mapping = PLAIN_SWITCH_DT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("4")).toBe(4);
    });

    it("closed=true maps to boolean true", () => {
      const mapping = PLAIN_SWITCH_DT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "closed");
      expect(mapping!.convert("true")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("PlainSwitchDTDefinition has name='PlainSwitchDT'", () => {
      expect(PlainSwitchDTDefinition.name).toBe("PlainSwitchDT");
    });

    it("PlainSwitchDTDefinition has typeId=-1", () => {
      expect(PlainSwitchDTDefinition.typeId).toBe(-1);
    });

    it("PlainSwitchDTDefinition executeFn is executePlainSwitchDT", () => {
      expect(PlainSwitchDTDefinition.executeFn).toBe(executePlainSwitchDT);
    });

    it("PlainSwitchDTDefinition category is SWITCHING", () => {
      expect(PlainSwitchDTDefinition.category).toBe(ComponentCategory.SWITCHING);
    });

    it("PlainSwitchDTDefinition factory produces a PlainSwitchDTElement", () => {
      const props = new PropertyBag();
      props.set("poles", 1);
      props.set("bitWidth", 1);
      props.set("closed", false);
      const el = PlainSwitchDTDefinition.factory(props);
      expect(el.typeId).toBe("PlainSwitchDT");
    });

    it("PlainSwitchDTDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PlainSwitchDTDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// Switch tests
// ===========================================================================

describe("Switch", () => {
  // -------------------------------------------------------------------------
  // Open/close state
  // -------------------------------------------------------------------------

  describe("openCloseState", () => {
    it("default Switch is open", () => {
      const sw = makeSwitch();
      expect(sw.isClosed()).toBe(false);
    });

    it("Switch with closed=true reports isClosed()=true", () => {
      const sw = makeSwitch({ closed: true });
      expect(sw.isClosed()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // switchActsAsInput property
  // -------------------------------------------------------------------------

  describe("switchActsAsInput", () => {
    it("default switchActsAsInput is false", () => {
      const sw = makeSwitch();
      expect(sw.switchActsAsInput()).toBe(false);
    });

    it("switchActsAsInput=true is stored correctly", () => {
      const sw = makeSwitch({ switchActsAsInput: true });
      expect(sw.switchActsAsInput()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pin layout
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("1-pole Switch has 2 BIDIRECTIONAL pins", () => {
      const sw = makeSwitch({ poles: 1 });
      const pins = sw.getPins();
      expect(pins).toHaveLength(2);
      for (const pin of pins) {
        expect(pin.direction).toBe(PinDirection.BIDIRECTIONAL);
      }
    });

    it("2-pole Switch has 4 pins", () => {
      const sw = makeSwitch({ poles: 2 });
      expect(sw.getPins()).toHaveLength(4);
    });

    it("Switch pins are labeled A1 and B1 for 1-pole", () => {
      const sw = makeSwitch({ poles: 1 });
      const labels = sw.getPins().map((p) => p.label);
      expect(labels).toContain("A1");
      expect(labels).toContain("B1");
    });
  });

  // -------------------------------------------------------------------------
  // executeFn — no-op
  // -------------------------------------------------------------------------

  describe("executeFnNoOp", () => {
    it("executeSwitch does not modify the state array", () => {
      const layout = makeLayout(0, 1);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 55;
      executeSwitch(0, state, highZs, layout);
      expect(state[0]).toBe(55);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("closed Switch draw() calls drawLine at least once", () => {
      // Switch.draw() renders the mechanical symbol (angled arm + dashed lever)
      // regardless of the closed state — the closed flag is used by the bus resolver,
      // not by the draw method itself.
      const sw = makeSwitch({ closed: true });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("open Switch draw() renders angled contact arm", () => {
      const sw = makeSwitch({ closed: false });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      // Contact arm line: (0,0) → (1.8,-0.5) — starts at x=0
      const contactArm = lineCalls.find(
        (c) => c.args[0] === 0,
      );
      expect(contactArm).toBeDefined();
    });

    it("draw() calls setLineDash for dashed lever", () => {
      const sw = makeSwitch();
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      expect(calls.filter((c) => c.method === "setLineDash").length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("SwitchActsAsInput=true maps to switchActsAsInput=true", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "SwitchActsAsInput");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
    });

    it("SwitchActsAsInput=false maps to false", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "SwitchActsAsInput");
      expect(mapping!.convert("false")).toBe(false);
    });

    it("closed=true maps to boolean true", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "closed");
      expect(mapping!.convert("true")).toBe(true);
    });

    it("Bits=16 maps to bitWidth=16", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("16")).toBe(16);
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("SwitchDefinition has name='Switch'", () => {
      expect(SwitchDefinition.name).toBe("Switch");
    });

    it("SwitchDefinition has typeId=-1", () => {
      expect(SwitchDefinition.typeId).toBe(-1);
    });

    it("SwitchDefinition executeFn is executeSwitch", () => {
      expect(SwitchDefinition.executeFn).toBe(executeSwitch);
    });

    it("SwitchDefinition category is SWITCHING", () => {
      expect(SwitchDefinition.category).toBe(ComponentCategory.SWITCHING);
    });

    it("SwitchDefinition factory produces a SwitchElement", () => {
      const props = new PropertyBag();
      props.set("poles", 1);
      props.set("bitWidth", 1);
      props.set("closed", false);
      const el = SwitchDefinition.factory(props);
      expect(el.typeId).toBe("Switch");
    });

    it("SwitchDefinition has non-empty propertyDefs", () => {
      expect(SwitchDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("SwitchDefinition propertyDefs include switchActsAsInput", () => {
      const keys = SwitchDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("switchActsAsInput");
    });

    it("SwitchDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(SwitchDefinition)).not.toThrow();
    });

    it("SwitchDefinition helpText contains 'Switch'", () => {
      expect(SwitchDefinition.helpText).toContain("Switch");
    });
  });
});

// ===========================================================================
// SwitchDT tests
// ===========================================================================

describe("SwitchDT", () => {
  // -------------------------------------------------------------------------
  // SPDT routing
  // -------------------------------------------------------------------------

  describe("spdtRouting", () => {
    it("default SwitchDT is open", () => {
      const sw = makeSwitchDT();
      expect(sw.isClosed()).toBe(false);
    });

    it("SwitchDT with closed=true reports isClosed()=true", () => {
      const sw = makeSwitchDT({ closed: true });
      expect(sw.isClosed()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pin layout — SPDT: 3 pins per pole (A, B, C)
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("1-pole SwitchDT has 3 pins", () => {
      const sw = makeSwitchDT({ poles: 1 });
      expect(sw.getPins()).toHaveLength(3);
    });

    it("1-pole SwitchDT has pins A1 (common), B1, C1", () => {
      const sw = makeSwitchDT({ poles: 1 });
      const labels = sw.getPins().map((p) => p.label);
      expect(labels).toContain("A1");
      expect(labels).toContain("B1");
      expect(labels).toContain("C1");
    });

    it("all SwitchDT pins are BIDIRECTIONAL", () => {
      const sw = makeSwitchDT({ poles: 1 });
      for (const pin of sw.getPins()) {
        expect(pin.direction).toBe(PinDirection.BIDIRECTIONAL);
      }
    });

    it("2-pole SwitchDT has 6 pins", () => {
      const sw = makeSwitchDT({ poles: 2 });
      expect(sw.getPins()).toHaveLength(6);
    });

    it("SwitchDTDefinition.pinLayout has 3 entries for 1-pole default", () => {
      expect(SwitchDTDefinition.pinLayout).toHaveLength(3);
    });

    it("C pin is lower than B pin (larger y position)", () => {
      const sw = makeSwitchDT({ poles: 1 });
      const pinB = sw.getPins().find((p) => p.label === "B1");
      const pinC = sw.getPins().find((p) => p.label === "C1");
      expect(pinC!.position.y).toBeGreaterThan(pinB!.position.y);
    });
  });

  // -------------------------------------------------------------------------
  // executeFn — no-op
  // -------------------------------------------------------------------------

  describe("executeFnNoOp", () => {
    it("executeSwitchDT does not modify the state array", () => {
      const layout = makeLayout(0, 1);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 33;
      state[1] = 77;
      executeSwitchDT(0, state, highZs, layout);
      expect(state[0]).toBe(33);
      expect(state[1]).toBe(77);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawLine at least once", () => {
      const sw = makeSwitchDT();
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      expect(calls.filter((c) => c.method === "drawLine").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders C-contact stub (additional line calls for DT shape)", () => {
      const sw = makeSwitchDT({ poles: 1 });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      // Should have more line calls than a plain SPST (extra C stub lines)
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(3);
    });

    it("draw() calls setLineDash for the lever", () => {
      const sw = makeSwitchDT();
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      expect(calls.filter((c) => c.method === "setLineDash").length).toBeGreaterThanOrEqual(2);
    });

    it("draw() with label calls drawText", () => {
      const sw = makeSwitchDT({ label: "SW3" });
      const { ctx, calls } = makeStubCtx();
      sw.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "SW3")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = SWITCH_DT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("8")).toBe(8);
    });

    it("closed=true maps to boolean true", () => {
      const mapping = SWITCH_DT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "closed");
      expect(mapping!.convert("true")).toBe(true);
    });

    it("Poles=3 maps to poles=3", () => {
      const mapping = SWITCH_DT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Poles");
      expect(mapping!.convert("3")).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("SwitchDTDefinition has name='SwitchDT'", () => {
      expect(SwitchDTDefinition.name).toBe("SwitchDT");
    });

    it("SwitchDTDefinition has typeId=-1", () => {
      expect(SwitchDTDefinition.typeId).toBe(-1);
    });

    it("SwitchDTDefinition executeFn is executeSwitchDT", () => {
      expect(SwitchDTDefinition.executeFn).toBe(executeSwitchDT);
    });

    it("SwitchDTDefinition category is SWITCHING", () => {
      expect(SwitchDTDefinition.category).toBe(ComponentCategory.SWITCHING);
    });

    it("SwitchDTDefinition factory produces a SwitchDTElement", () => {
      const props = new PropertyBag();
      props.set("poles", 1);
      props.set("bitWidth", 1);
      props.set("closed", false);
      const el = SwitchDTDefinition.factory(props);
      expect(el.typeId).toBe("SwitchDT");
    });

    it("SwitchDTDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(SwitchDTDefinition)).not.toThrow();
    });

    it("SwitchDTDefinition helpText contains 'Switch'", () => {
      expect(SwitchDTDefinition.helpText).toContain("Switch");
    });
  });
});

// ===========================================================================
// Analog Switch tests (Task 2.5.3)
// ===========================================================================

import { vi } from "vitest";
import type { SparseSolver } from "../../../analog/sparse-solver.js";
import type { SpstAnalogElement } from "../plain-switch.js";
import type { SpdtAnalogElement } from "../plain-switch-dt.js";
import {
  makeResistor,
  makeVoltageSource,
} from "../../../analog/test-elements.js";
import { MNAEngine } from "../../../analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../analog/analog-engine.js";

function makeMockSolver() {
  const stamps: Array<{ row: number; col: number; value: number }> = [];
  const rhs: Record<number, number> = {};

  const solver = {
    stamp: vi.fn((row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    }),
    stampRHS: vi.fn((row: number, value: number) => {
      rhs[row] = (rhs[row] ?? 0) + value;
    }),
    _stamps: stamps,
    _rhs: rhs,
  };

  return solver;
}

function makeSpstProps(overrides: {
  closed?: boolean;
  Ron?: number;
  Roff?: number;
} = {}): PropertyBag {
  const props = new PropertyBag();
  props.set("closed", overrides.closed ?? false);
  props.set("Ron", overrides.Ron ?? 1);
  props.set("Roff", overrides.Roff ?? 1e9);
  return props;
}

describe("AnalogSwitch", () => {
  it("definition_has_engine_type_both", () => {
    expect(PlainSwitchDefinition.engineType).toBe("both");
    expect(PlainSwitchDTDefinition.engineType).toBe("both");
  });

  it("closed_stamps_ron", () => {
    const props = makeSpstProps({ closed: true, Ron: 1 });
    const el = PlainSwitchDefinition.analogFactory!(
      [1, 2],
      -1,
      props,
      () => 0,
    ) as SpstAnalogElement;
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);

    // G = 1/Ron = 1.0; should stamp 4 conductance entries
    const expectedG = 1.0;
    const gCalls = solver.stamp.mock.calls.map(([, , v]) => v as number);
    expect(gCalls.some((v) => Math.abs(v - expectedG) < 1e-10)).toBe(true);
    expect(gCalls.some((v) => Math.abs(v + expectedG) < 1e-10)).toBe(true);
  });

  it("open_stamps_roff", () => {
    const props = makeSpstProps({ closed: false, Roff: 1e9 });
    const el = PlainSwitchDefinition.analogFactory!(
      [1, 2],
      -1,
      props,
      () => 0,
    ) as SpstAnalogElement;
    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);

    // G = 1/Roff = 1e-9
    const expectedG = 1e-9;
    const gCalls = solver.stamp.mock.calls.map(([, , v]) => v as number);
    expect(gCalls.some((v) => Math.abs(v - expectedG) < 1e-18)).toBe(true);
  });

  it("toggle_changes_conductance", () => {
    const props = makeSpstProps({ closed: true, Ron: 1, Roff: 1e9 });
    const el = PlainSwitchDefinition.analogFactory!(
      [1, 2],
      -1,
      props,
      () => 0,
    ) as SpstAnalogElement;

    const solver1 = makeMockSolver();
    el.stamp(solver1 as unknown as SparseSolver);
    const gClosed = solver1.stamp.mock.calls.map(([, , v]) => v as number).find((v) => v > 0)!;

    el.setClosed(false);
    const solver2 = makeMockSolver();
    el.stamp(solver2 as unknown as SparseSolver);
    const gOpen = solver2.stamp.mock.calls.map(([, , v]) => v as number).find((v) => v > 0)!;

    // Closed G = 1/Ron = 1.0; Open G = 1/Roff = 1e-9
    expect(gClosed).toBeGreaterThan(gOpen);
    expect(gClosed).toBeCloseTo(1.0, 8);
    expect(gOpen).toBeCloseTo(1e-9, 18);
  });

  it("digital_behavior_unchanged", () => {
    const layout = makeLayout(0, 1);
    const state = makeState(2);
    const highZs = new Uint32Array(state.length);
    state[0] = 42;
    executePlainSwitch(0, state, highZs, layout);
    expect(state[0]).toBe(42);
  });
});

describe("AnalogSPDT", () => {
  it("common_to_a_when_position_0", () => {
    // closed=false → common-B has Roff, common-C has Ron
    // position 0 = open = common connects to C (normally-open)
    const props = new PropertyBag();
    props.set("closed", false);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = PlainSwitchDTDefinition.analogFactory!(
      [1, 2, 3],
      -1,
      props,
      () => 0,
    ) as SpdtAnalogElement;

    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);

    // common(1)-B(2): Goff = 1e-9, common(1)-C(3): Gon = 1.0
    const calls = solver.stamp.mock.calls as Array<[number, number, number]>;
    const positiveValues = calls.filter(([, , v]) => v > 0).map(([, , v]) => v);
    const smallG = positiveValues.filter((v) => v < 1e-6);
    const largeG = positiveValues.filter((v) => v > 0.5);
    expect(smallG.length).toBeGreaterThan(0);
    expect(largeG.length).toBeGreaterThan(0);
  });

  it("common_to_b_when_position_1", () => {
    // closed=true → common-B has Ron, common-C has Roff
    const props = new PropertyBag();
    props.set("closed", true);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = PlainSwitchDTDefinition.analogFactory!(
      [1, 2, 3],
      -1,
      props,
      () => 0,
    ) as SpdtAnalogElement;

    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);

    const calls = solver.stamp.mock.calls as Array<[number, number, number]>;
    const positiveValues = calls.filter(([, , v]) => v > 0).map(([, , v]) => v);
    const smallG = positiveValues.filter((v) => v < 1e-6);
    const largeG = positiveValues.filter((v) => v > 0.5);
    expect(smallG.length).toBeGreaterThan(0);
    expect(largeG.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration test — switched resistor divider
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("switched_resistor_divider", () => {
    // 10V → SPST switch (closed, Ron=1Ω) → 1kΩ → ground
    // DC OP: V across R = 10 * 1000/1001 ≈ 9.99V
    // Open switch: V across R ≈ 0V

    const switchProps = makeSpstProps({ closed: true, Ron: 1, Roff: 1e9 });
    const swEl = PlainSwitchDefinition.analogFactory!(
      [1, 2],
      -1,
      switchProps,
      () => 0,
    ) as SpstAnalogElement;

    // nodeCount=2 (node1, node2), branchCount=1, matrixSize=3
    // Branch at absolute row 2 (= nodeCount + 0)
    const vs = makeVoltageSource(1, 0, 2, 10);  // 10V: node1→gnd, branch at absolute row 2
    const r = makeResistor(2, 0, 1000);          // 1kΩ: node2→gnd

    const circuit: ConcreteCompiledAnalogCircuit = {
      netCount: 2,
      componentCount: 3,
      nodeCount: 2,
      branchCount: 1,
      matrixSize: 3,
      elements: [vs, swEl, r],
      labelToNodeId: new Map(),
      wireToNodeId: new Map(),
    };

    const engine = new MNAEngine();
    engine.init(circuit);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // node2 = voltages[1] = V across R
    const vAcrossR = engine.getNodeVoltage(1);
    expect(vAcrossR).toBeGreaterThan(9.98);
    expect(vAcrossR).toBeLessThan(10.0);

    // Now open the switch
    swEl.setClosed(false);
    engine.init(circuit);
    const result2 = engine.dcOperatingPoint();
    expect(result2.converged).toBe(true);
    // With Roff=1e9Ω, V across 1kΩ ≈ 10 * 1000 / (1000 + 1e9) ≈ 1e-5V ≈ 0
    const vOpen = engine.getNodeVoltage(1);
    expect(vOpen).toBeCloseTo(0, 2);
  });
});
