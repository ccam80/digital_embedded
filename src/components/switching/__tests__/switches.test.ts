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
import type { PropertyValue } from "../../../core/properties.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers- ComponentLayout mock
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
// Helpers- RenderContext mock
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
  // executeSwitch- writes closed flag to state
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
      // Contact arm line: (0,0) → (1.8,-0.5)- starts at x=0
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
  // Pin layout- SPDT: 3 pins per pole (A, B, C)
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
  // executeSwitchDT- writes closed flag to state
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
// Analog Switch + SwitchDT tests- §4c migration, 2026-05-03
//
// The previous engine-impersonator block (`AnalogSwitch` / `AnalogSPDT`)
// drove `el.setup(ctx)` and `el.load(ctx)` directly through hand-rolled
// SetupContext/LoadContext mocks and asserted on the private SparseSolver
// `_getInsertionOrder()` shape (TSTALLOC PP/PN/NP/NN sequence). That is a
// §4 violation (no test calls element.setup()/element.load() directly) and
// a §3 poison pattern (matrix-handle order is an engine-internal contract
// already covered bit-exact by the ngspice harness). Per the §4a precedent
// for inductor/capacitor, those engine-impersonator tests are deleted. In
// their place: behavioural circuits routed through `buildFixture` that
// observe Ron / Roff / NC inversion via DC operating-point node voltages.
//
// Integration test (`switched_resistor_divider`) is migrated 1:1 onto the
// public surface: `buildFixture({ build })` + `coordinator.dcOperatingPoint()`
// + `engine.getNodeVoltage(...)`.
// ===========================================================================

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factories. SPST (Switch) and SPDT (SwitchDT) both expose the
// `behavioral` analog model entry; setting `model: "behavioral"` overrides
// the digital `defaultModel` so the analog factory wires into the unified
// compiler. Ron / Roff plumb through the property bag.
// ---------------------------------------------------------------------------

interface SpstDividerParams {
  vSource: number;
  closed: boolean;
  Ron?: number;
  Roff?: number;
  normallyClosed?: boolean;
  rLoad?: number;
}

function buildSpstDivider(facade: DefaultSimulatorFacade, p: SpstDividerParams): Circuit {
  // VS → switch(A1→B1) → rload → GND. Closed: V(B1) ≈ Vs * rLoad/(Ron+rLoad);
  // open: V(B1) ≈ Vs * rLoad/(Roff+rLoad) ≈ 0 for Roff=1e9 and rLoad=1k.
  const swProps: Record<string, string | number | boolean> = {
    label: "sw1",
    model: "behavioral",
    closed: p.closed,
    Ron: p.Ron ?? 1,
    Roff: p.Roff ?? 1e9,
  };
  if (p.normallyClosed !== undefined) swProps.normallyClosed = p.normallyClosed;
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "vs1",   voltage: p.vSource } },
      { id: "sw",   type: "Switch",          props: swProps },
      { id: "rl",   type: "Resistor",        props: { label: "rl",    resistance: p.rLoad ?? 1000 } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vs:pos", "sw:A1"],
      ["sw:B1",  "rl:pos"],
      ["rl:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

interface SpdtDividerParams {
  vSource: number;
  closed: boolean;
  Ron?: number;
  Roff?: number;
  rLoadB?: number;
  rLoadC?: number;
}

function buildSpdtDivider(facade: DefaultSimulatorFacade, p: SpdtDividerParams): Circuit {
  // VS → SPDT(A1) ; SPDT(B1) → rLoadB → GND ; SPDT(C1) → rLoadC → GND.
  //
  // SPDT semantics (switch-dt.ts SwitchDTAnalogElement): closed=true ⇒ AB
  // closed (Ron) and AC open (Roff); closed=false ⇒ AB open and AC closed.
  // With Vs=10V and rLoadB=rLoadC=1k:
  //   closed=true  → V(B1) ≈ 10·1k/(1+1k) ≈ 9.99V , V(C1) ≈ 0V
  //   closed=false → V(B1) ≈ 0V               , V(C1) ≈ 9.99V
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "vs1",  voltage: p.vSource } },
      { id: "sw",   type: "SwitchDT",        props: { label: "sw1",  model: "behavioral", closed: p.closed, Ron: p.Ron ?? 1, Roff: p.Roff ?? 1e9 } },
      { id: "rb",   type: "Resistor",        props: { label: "rb",   resistance: p.rLoadB ?? 1000 } },
      { id: "rc",   type: "Resistor",        props: { label: "rc",   resistance: p.rLoadC ?? 1000 } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vs:pos", "sw:A1"],
      ["sw:B1",  "rb:pos"],
      ["rb:neg", "gnd:out"],
      ["sw:C1",  "rc:pos"],
      ["rc:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

describe("AnalogSwitch", () => {
  it("definition_has_engine_type_both", () => {
    expect(SwitchDefinition.models?.digital).toBeDefined();
    expect(SwitchDefinition.modelRegistry?.behavioral).toBeDefined();
    expect(SwitchDTDefinition.models?.digital).toBeDefined();
    expect(SwitchDTDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("closed_conducts_via_ron", () => {
    // Vs=10V, Ron=1Ω, rLoad=1kΩ. V(B1) = 10 * 1000 / (1 + 1000) ≈ 9.9900V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:B1"));
    expect(vB).toBeCloseTo(10 * 1000 / 1001, 3);
  });

  it("open_blocks_via_roff", () => {
    // Vs=10V, Roff=1e9Ω, rLoad=1kΩ. V(B1) = 10 * 1000 / (1e9 + 1000) ≈ 1e-5V.
    // The pull-down through rLoad to ground dominates; the open switch passes
    // negligible current.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: false, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:B1"));
    // Strict observable: open-switch leakage gives V(B1) far below the
    // closed-switch divider voltage. 1e-3 V is six orders below 9.99V.
    expect(Math.abs(vB)).toBeLessThan(1e-3);
  });

  it("normallyClosed_inverts_conductance", () => {
    // closed=false + normallyClosed=true ⇒ effectively closed at rest, so
    // V(B1) sits at the closed-divider voltage rather than the open one.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: false, normallyClosed: true,
        Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:B1"));
    expect(vB).toBeCloseTo(10 * 1000 / 1001, 3);
  });

  it("ron_value_propagates_to_divider_voltage", () => {
    // Ron=100Ω → V(B1) = 10 * 1000/1100 ≈ 9.0909V (clearly distinct from
    // Ron=1's 9.9900V). Proves Ron property plumbs through to the analog
    // model rather than being silently ignored.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: true, Ron: 100, Roff: 1e9, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:B1"));
    expect(vB).toBeCloseTo(10 * 1000 / 1100, 3);
  });
});

describe("AnalogSPDT", () => {
  it("closed_routes_to_b", () => {
    // closed=true ⇒ AB closed (Ron), AC open (Roff). V(B1) ≈ 9.99V, V(C1) ≈ 0.
    const fix = buildFixture({
      build: (_r, facade) => buildSpdtDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:B1"));
    const vC = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:C1"));
    expect(vB).toBeCloseTo(10 * 1000 / 1001, 3);
    expect(Math.abs(vC)).toBeLessThan(1e-3);
  });

  it("open_routes_to_c", () => {
    // closed=false ⇒ AB open (Roff), AC closed (Ron). V(B1) ≈ 0, V(C1) ≈ 9.99V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpdtDivider(facade, {
        vSource: 10, closed: false, Ron: 1, Roff: 1e9,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:B1"));
    const vC = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:C1"));
    expect(Math.abs(vB)).toBeLessThan(1e-3);
    expect(vC).toBeCloseTo(10 * 1000 / 1001, 3);
  });
});

// ---------------------------------------------------------------------------
// Integration- switched resistor divider via the public engine surface.
// 10V → Switch (closed, Ron=1Ω) → 1kΩ → GND. V across R = 10·1000/1001 ≈ 9.99V.
// (Replaces the previous makeSimpleCtx / solveDcOp / hand-rolled-elements
// approach; semantics-preserving 1:1 migration.)
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("switched_resistor_divider", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vAcrossR = fix.engine.getNodeVoltage(nodeOf(fix, "sw1:B1"));
    expect(vAcrossR).toBeGreaterThan(9.98);
    expect(vAcrossR).toBeLessThanOrEqual(10.0);
  });
});
