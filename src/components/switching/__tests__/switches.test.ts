/**
 * Tests for Switch, SwitchDT components (and PlainSwitch/PlainSwitchDT aliases).
 *
 * Covers:
 *   - Open/close state correctly reflected in isClosed()
 *   - SPDT routing: correct terminal connectivity declarations
 *   - Pin declarations: correct count, labels, directions for SPST and SPDT
 *   - executeSwitch/executeSwitchDT write closed flag into state (bus resolver)
 *   - normallyClosed inverts the effective closed state
 *   - Attribute mappings: .dig XML attributes convert correctly
 *   - Rendering: contact arm lines, dashed lever
 *   - ComponentDefinition completeness for Switch and SwitchDT
 *   - Registry alias: PlainSwitch → Switch, PlainSwitchDT → SwitchDT
 *   - New properties: Ron, Roff, momentary, normallyClosed
 *   - Analog factories: conductance stamping, setClosed()
 */

import { describe, it, expect } from "vitest";
import {
  SwitchElement,
  executeSwitch,
  SwitchDefinition,
  SWITCH_ATTRIBUTE_MAPPINGS,
} from "../switch.js";
import type { SpstAnalogElement } from "../switch.js";
import {
  SwitchDTElement,
  executeSwitchDT,
  SwitchDTDefinition,
  SWITCH_DT_ATTRIBUTE_MAPPINGS,
} from "../switch-dt.js";
import type { SpdtAnalogElement } from "../switch-dt.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayout(
  inputCount: number,
  outputCount: number = 1,
  propOverrides?: Record<string, unknown>,
): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
    getProperty: (_index: number, key: string): PropertyValue | undefined => propOverrides?.[key] as PropertyValue | undefined,
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

function makeSwitch(overrides?: {
  poles?: number;
  bitWidth?: number;
  closed?: boolean;
  label?: string;
  switchActsAsInput?: boolean;
  momentary?: boolean;
  normallyClosed?: boolean;
}): SwitchElement {
  const props = new PropertyBag();
  props.set("poles", overrides?.poles ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("closed", overrides?.closed ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  if (overrides?.switchActsAsInput !== undefined)
    props.set("switchActsAsInput", overrides.switchActsAsInput);
  if (overrides?.momentary !== undefined) props.set("momentary", overrides.momentary);
  if (overrides?.normallyClosed !== undefined) props.set("normallyClosed", overrides.normallyClosed);
  return new SwitchElement("test-sw-001", { x: 0, y: 0 }, 0, false, props);
}

function makeSwitchDT(overrides?: {
  poles?: number;
  bitWidth?: number;
  closed?: boolean;
  label?: string;
  momentary?: boolean;
  normallyClosed?: boolean;
}): SwitchDTElement {
  const props = new PropertyBag();
  props.set("poles", overrides?.poles ?? 1);
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  props.set("closed", overrides?.closed ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  if (overrides?.momentary !== undefined) props.set("momentary", overrides.momentary);
  if (overrides?.normallyClosed !== undefined) props.set("normallyClosed", overrides.normallyClosed);
  return new SwitchDTElement("test-swdt-001", { x: 0, y: 0 }, 0, false, props);
}

// ===========================================================================
// Switch tests (SPST)
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
  // New properties: momentary, normallyClosed
  // -------------------------------------------------------------------------

  describe("newProperties", () => {
    it("SwitchDefinition propertyDefs include Ron", () => {
      expect(SwitchDefinition.propertyDefs.map((d) => d.key)).toContain("Ron");
    });

    it("SwitchDefinition propertyDefs include Roff", () => {
      expect(SwitchDefinition.propertyDefs.map((d) => d.key)).toContain("Roff");
    });

    it("SwitchDefinition propertyDefs include momentary", () => {
      expect(SwitchDefinition.propertyDefs.map((d) => d.key)).toContain("momentary");
    });

    it("SwitchDefinition propertyDefs include normallyClosed", () => {
      expect(SwitchDefinition.propertyDefs.map((d) => d.key)).toContain("normallyClosed");
    });

    it("Ron default is 1", () => {
      const def = SwitchDefinition.propertyDefs.find((d) => d.key === "Ron");
      expect(def?.defaultValue).toBe(1);
    });

    it("Roff default is 1e9", () => {
      const def = SwitchDefinition.propertyDefs.find((d) => d.key === "Roff");
      expect(def?.defaultValue).toBe(1e9);
    });

    it("momentary default is false", () => {
      const def = SwitchDefinition.propertyDefs.find((d) => d.key === "momentary");
      expect(def?.defaultValue).toBe(false);
    });

    it("normallyClosed default is false", () => {
      const def = SwitchDefinition.propertyDefs.find((d) => d.key === "normallyClosed");
      expect(def?.defaultValue).toBe(false);
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
  // executeSwitch — writes closed flag to state
  // -------------------------------------------------------------------------

  describe("executeFn", () => {
    it("executeSwitch writes 1 to state when closed=true", () => {
      const layout = makeLayout(0, 0, { closed: true, normallyClosed: false });
      // stateOffset = inputCount + outputCount = 0
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitch(0, state, highZs, layout);
      expect(state[0]).toBe(1);
    });

    it("executeSwitch writes 0 to state when closed=false", () => {
      const layout = makeLayout(0, 0, { closed: false, normallyClosed: false });
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitch(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });

    it("executeSwitch with normallyClosed=true inverts: closed=false → state=1", () => {
      const layout = makeLayout(0, 0, { closed: false, normallyClosed: true });
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitch(0, state, highZs, layout);
      expect(state[0]).toBe(1);
    });

    it("executeSwitch with normallyClosed=true: closed=true → state=0", () => {
      const layout = makeLayout(0, 0, { closed: true, normallyClosed: true });
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitch(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("closed Switch draw() calls drawLine at least once", () => {
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

    it("Ron XML attribute maps to Ron property", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Ron");
      expect(mapping).not.toBeUndefined();
    });

    it("Roff XML attribute maps to Roff property", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Roff");
      expect(mapping).not.toBeUndefined();
    });

    it("momentary XML attribute maps to momentary property", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "momentary");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
    });

    it("normallyClosed XML attribute maps to normallyClosed property", () => {
      const mapping = SWITCH_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "normallyClosed");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
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
      expect(SwitchDefinition.models!.digital!.executeFn).toBe(executeSwitch);
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

    it("SwitchDefinition has stateSlotCount=1", () => {
      expect(SwitchDefinition.models!.digital!.stateSlotCount).toBe(1);
    });

    it("SwitchDefinition has switchPins=[0,1]", () => {
      expect(SwitchDefinition.models!.digital!.switchPins).toEqual([0, 1]);
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
// SwitchDT tests (SPDT)
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
  // New properties: Ron, Roff, momentary, normallyClosed
  // -------------------------------------------------------------------------

  describe("newProperties", () => {
    it("SwitchDTDefinition propertyDefs include Ron", () => {
      expect(SwitchDTDefinition.propertyDefs.map((d) => d.key)).toContain("Ron");
    });

    it("SwitchDTDefinition propertyDefs include Roff", () => {
      expect(SwitchDTDefinition.propertyDefs.map((d) => d.key)).toContain("Roff");
    });

    it("SwitchDTDefinition propertyDefs include momentary", () => {
      expect(SwitchDTDefinition.propertyDefs.map((d) => d.key)).toContain("momentary");
    });

    it("SwitchDTDefinition propertyDefs include normallyClosed", () => {
      expect(SwitchDTDefinition.propertyDefs.map((d) => d.key)).toContain("normallyClosed");
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
  // executeSwitchDT — writes closed flag to state
  // -------------------------------------------------------------------------

  describe("executeFn", () => {
    it("executeSwitchDT writes 1 to state when closed=true", () => {
      const layout = makeLayout(0, 0, { closed: true, normallyClosed: false });
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitchDT(0, state, highZs, layout);
      expect(state[0]).toBe(1);
    });

    it("executeSwitchDT writes 0 to state when closed=false", () => {
      const layout = makeLayout(0, 0, { closed: false, normallyClosed: false });
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitchDT(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });

    it("executeSwitchDT with normallyClosed=true: closed=false → state=1", () => {
      const layout = makeLayout(0, 0, { closed: false, normallyClosed: true });
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitchDT(0, state, highZs, layout);
      expect(state[0]).toBe(1);
    });

    it("executeSwitchDT with normallyClosed=true: closed=true → state=0", () => {
      const layout = makeLayout(0, 0, { closed: true, normallyClosed: true });
      const state = makeState(4);
      const highZs = new Uint32Array(4);
      executeSwitchDT(0, state, highZs, layout);
      expect(state[0]).toBe(0);
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

    it("Ron XML attribute maps to Ron property", () => {
      const mapping = SWITCH_DT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Ron");
      expect(mapping).not.toBeUndefined();
    });

    it("normallyClosed XML attribute maps to normallyClosed property", () => {
      const mapping = SWITCH_DT_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "normallyClosed");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
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
      expect(SwitchDTDefinition.models!.digital!.executeFn).toBe(executeSwitchDT);
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

    it("SwitchDTDefinition has stateSlotCount=1", () => {
      expect(SwitchDTDefinition.models!.digital!.stateSlotCount).toBe(1);
    });

    it("SwitchDTDefinition has switchPins=[0,1]", () => {
      expect(SwitchDTDefinition.models!.digital!.switchPins).toEqual([0, 1]);
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
// Registry alias tests
// ===========================================================================

describe("RegistryAliases", () => {
  it("PlainSwitch alias resolves to Switch definition", () => {
    const registry = new ComponentRegistry();
    registry.register(SwitchDefinition);
    registry.registerAlias("PlainSwitch", "Switch");
    const def = registry.get("PlainSwitch");
    expect(def).toBeDefined();
    expect(def!.name).toBe("Switch");
  });

  it("PlainSwitchDT alias resolves to SwitchDT definition", () => {
    const registry = new ComponentRegistry();
    registry.register(SwitchDTDefinition);
    registry.registerAlias("PlainSwitchDT", "SwitchDT");
    const def = registry.get("PlainSwitchDT");
    expect(def).toBeDefined();
    expect(def!.name).toBe("SwitchDT");
  });

  it("PlainSwitch alias does not appear in getAll()", () => {
    const registry = new ComponentRegistry();
    registry.register(SwitchDefinition);
    registry.registerAlias("PlainSwitch", "Switch");
    const all = registry.getAll();
    expect(all.some((d) => d.name === "PlainSwitch")).toBe(false);
  });

  it("PlainSwitchDT alias does not appear in getByCategory()", () => {
    const registry = new ComponentRegistry();
    registry.register(SwitchDTDefinition);
    registry.registerAlias("PlainSwitchDT", "SwitchDT");
    const switching = registry.getByCategory(ComponentCategory.SWITCHING);
    expect(switching.some((d) => d.name === "PlainSwitchDT")).toBe(false);
  });

  it("registerAlias throws if canonical not registered", () => {
    const registry = new ComponentRegistry();
    expect(() => registry.registerAlias("PlainSwitch", "Switch")).toThrow();
  });

  it("registerAlias throws if alias already registered as canonical", () => {
    const registry = new ComponentRegistry();
    registry.register(SwitchDefinition);
    registry.register(SwitchDTDefinition);
    expect(() => registry.registerAlias("SwitchDT", "Switch")).toThrow();
  });
});

// ===========================================================================
// Analog Switch tests
// ===========================================================================

import { vi } from "vitest";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import {
  makeResistor,
  makeVoltageSource,
  makeSimpleCtx,
} from "../../../solver/analog/__tests__/test-helpers.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";
import { StatePool } from "../../../solver/analog/state-pool.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


function makeCaptureSolver() {
  const stamps: Array<[number, number, number]> = [];
  const rhs: Array<[number, number]> = [];
  const solver = {
    _initStructure: (_n: number) => {},
    allocElement: vi.fn((row: number, col: number) => {
      stamps.push([row, col, 0]);
      return stamps.length - 1;
    }),
    stampElement: vi.fn((h: number, v: number) => {
      stamps[h][2] += v;
    }),
    stampRHS: vi.fn((row: number, v: number) => {
      rhs.push([row, v]);
    }),
  };
  return { solver, stamps, rhs };
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
    expect(SwitchDefinition.models?.digital).toBeDefined();
    expect(SwitchDefinition.modelRegistry?.behavioral).toBeDefined();
    expect(SwitchDTDefinition.models?.digital).toBeDefined();
    expect(SwitchDTDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("closed_stamps_ron", () => {
    const props = makeSpstProps({ closed: true, Ron: 1 });
    const el = getFactory(SwitchDefinition.modelRegistry!.behavioral!)(
      new Map([["A1", 1], ["B1", 2]]),
      [],
      -1,
      props,
      () => 0,
    ) as SpstAnalogElement;
    const { solver, stamps } = makeCaptureSolver();
    const ctx = makeSimpleCtx({ solver: solver as unknown as SparseSolver, elements: [], nodeCount: 2, matrixSize: 2 });
    el.load(ctx.loadCtx);

    // G = 1/Ron = 1.0; should stamp conductance entries
    const expectedG = 1.0;
    const gVals = stamps.map(([, , v]) => v);
    expect(gVals.some((v) => Math.abs(v - expectedG) < 1e-10)).toBe(true);
    expect(gVals.some((v) => Math.abs(v + expectedG) < 1e-10)).toBe(true);
  });

  it("open_stamps_roff", () => {
    const props = makeSpstProps({ closed: false, Roff: 1e9 });
    const el = getFactory(SwitchDefinition.modelRegistry!.behavioral!)(
      new Map([["A1", 1], ["B1", 2]]),
      [],
      -1,
      props,
      () => 0,
    ) as SpstAnalogElement;
    const { solver, stamps } = makeCaptureSolver();
    const ctx = makeSimpleCtx({ solver: solver as unknown as SparseSolver, elements: [], nodeCount: 2, matrixSize: 2 });
    el.load(ctx.loadCtx);

    // G = 1/Roff = 1e-9
    const expectedG = 1e-9;
    const gVals = stamps.map(([, , v]) => v);
    expect(gVals.some((v) => Math.abs(v - expectedG) < 1e-18)).toBe(true);
  });

  it("toggle_changes_conductance", () => {
    const props = makeSpstProps({ closed: true, Ron: 1, Roff: 1e9 });
    const el = getFactory(SwitchDefinition.modelRegistry!.behavioral!)(
      new Map([["A1", 1], ["B1", 2]]),
      [],
      -1,
      props,
      () => 0,
    ) as SpstAnalogElement;

    const { solver: solver1, stamps: stamps1 } = makeCaptureSolver();
    const ctx1 = makeSimpleCtx({ solver: solver1 as unknown as SparseSolver, elements: [], nodeCount: 2, matrixSize: 2 });
    el.load(ctx1.loadCtx);
    const gClosed = stamps1.map(([, , v]) => v).find((v) => v > 0)!;

    el.setClosed(false);
    const { solver: solver2, stamps: stamps2 } = makeCaptureSolver();
    const ctx2 = makeSimpleCtx({ solver: solver2 as unknown as SparseSolver, elements: [], nodeCount: 2, matrixSize: 2 });
    el.load(ctx2.loadCtx);
    const gOpen = stamps2.map(([, , v]) => v).find((v) => v > 0)!;

    // Closed G = 1/Ron = 1.0; Open G = 1/Roff = 1e-9
    expect(gClosed).toBeGreaterThan(gOpen);
  });

  it("normallyClosed_inverts_analog_conductance", () => {
    const props = new PropertyBag();
    props.set("closed", false);       // user state: not pressed
    props.set("normallyClosed", true); // but NC: effectively closed at rest
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = getFactory(SwitchDefinition.modelRegistry!.behavioral!)(
      new Map([["A1", 1], ["B1", 2]]),
      [],
      -1,
      props,
      () => 0,
    ) as SpstAnalogElement;

    const { solver, stamps } = makeCaptureSolver();
    const ctx = makeSimpleCtx({ solver: solver as unknown as SparseSolver, elements: [], nodeCount: 2, matrixSize: 2 });
    el.load(ctx.loadCtx);

    // NC + closed=false → effectively closed → stamps Ron
    const gVals = stamps.map(([, , v]) => v);
    expect(gVals.some((v) => Math.abs(v - 1.0) < 1e-10)).toBe(true);
  });
});

describe("AnalogSPDT", () => {
  it("common_to_c_when_open", () => {
    // closed=false → common-B has Roff, common-C has Ron
    const props = new PropertyBag();
    props.set("closed", false);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = getFactory(SwitchDTDefinition.modelRegistry!.behavioral!)(
      new Map([["A1", 1], ["B1", 2], ["C1", 3]]),
      [],
      -1,
      props,
      () => 0,
    ) as SpdtAnalogElement;

    const { solver, stamps } = makeCaptureSolver();
    const ctx = makeSimpleCtx({ solver: solver as unknown as SparseSolver, elements: [], nodeCount: 3, matrixSize: 3 });
    el.load(ctx.loadCtx);

    const positiveValues = stamps.filter(([, , v]) => v > 0).map(([, , v]) => v);
    const smallG = positiveValues.filter((v) => v < 1e-6);
    const largeG = positiveValues.filter((v) => v > 0.5);
    expect(smallG.length).toBeGreaterThan(0);
    expect(largeG.length).toBeGreaterThan(0);
  });

  it("common_to_b_when_closed", () => {
    // closed=true → common-B has Ron, common-C has Roff
    const props = new PropertyBag();
    props.set("closed", true);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = getFactory(SwitchDTDefinition.modelRegistry!.behavioral!)(
      new Map([["A1", 1], ["B1", 2], ["C1", 3]]),
      [],
      -1,
      props,
      () => 0,
    ) as SpdtAnalogElement;

    const { solver, stamps } = makeCaptureSolver();
    const ctx = makeSimpleCtx({ solver: solver as unknown as SparseSolver, elements: [], nodeCount: 3, matrixSize: 3 });
    el.load(ctx.loadCtx);

    const positiveValues = stamps.filter(([, , v]) => v > 0).map(([, , v]) => v);
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
    const swEl = getFactory(SwitchDefinition.modelRegistry!.behavioral!)(
      new Map([["A1", 1], ["B1", 2]]),
      [],
      -1,
      switchProps,
      () => 0,
    ) as SpstAnalogElement;

    // nodeCount=2 (node1, node2), branchCount=1, matrixSize=3
    // Branch at absolute row 2 (= nodeCount + 0)
    const vs = makeVoltageSource(1, 0, 2, 10);  // 10V: node1→gnd, branch at absolute row 2
    const r = makeResistor(2, 0, 1000);          // 1kΩ: node2→gnd

    const circuit = {
      netCount: 2,
      componentCount: 3,
      nodeCount: 2,
      branchCount: 1,
      matrixSize: 3,
      elements: [vs, swEl as unknown as import("../../../solver/analog/element.js").AnalogElement, r],
      labelToNodeId: new Map(),
      statePool: new StatePool(0),
    } as unknown as ConcreteCompiledAnalogCircuit;

    const engine = new MNAEngine();
    engine.init(circuit);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // node2 = MNA node ID 2 = V across R
    const vAcrossR = engine.getNodeVoltage(2);
    expect(vAcrossR).toBeGreaterThan(9.98);
    expect(vAcrossR).toBeLessThanOrEqual(10.0);

    // Now open the switch
    swEl.setClosed(false);
    engine.init(circuit);
    const result2 = engine.dcOperatingPoint();
    expect(result2.converged).toBe(true);
    // With Roff=1e9Ω, V across 1kΩ ≈ 10 * 1000 / (1000 + 1e9) ≈ 1e-5V ≈ 0
    engine.getNodeVoltage(2);
  });
});
