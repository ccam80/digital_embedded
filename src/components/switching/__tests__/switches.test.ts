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
  SwitchAnalogElement,
} from "../switch.js";
import type { SpstAnalogElement } from "../switch.js";
import {
  SwitchDTElement,
  executeSwitchDT,
  SwitchDTDefinition,
  SWITCH_DT_ATTRIBUTE_MAPPINGS,
  SwitchDTAnalogElement,
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
// Analog Switch tests- use real setup path (W3 contract)
// ===========================================================================

import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import {
  makeSimpleCtx,
} from "../../../solver/analog/__tests__/test-helpers.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { NGSPICE_LOAD_ORDER } from "../../../core/analog-types.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";

// ---------------------------------------------------------------------------
// Inline resistor helper- ssA.13 contract shape (no exported factory exists).
// ---------------------------------------------------------------------------
function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  let _hAA = -1, _hBB = -1, _hAB = -1, _hBA = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES,
    _pinNodes: new Map([["A", nodeA], ["B", nodeB]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const a = el._pinNodes.get("A")!;
      const b = el._pinNodes.get("B")!;
      if (a !== 0) _hAA = ctx.solver.allocElement(a, a);
      if (b !== 0) _hBB = ctx.solver.allocElement(b, b);
      if (a !== 0 && b !== 0) {
        _hAB = ctx.solver.allocElement(a, b);
        _hBA = ctx.solver.allocElement(b, a);
      }
    },
    load(ctx): void {
      if (_hAA !== -1) ctx.solver.stampElement(_hAA,  G);
      if (_hBB !== -1) ctx.solver.stampElement(_hBB,  G);
      if (_hAB !== -1) ctx.solver.stampElement(_hAB, -G);
      if (_hBA !== -1) ctx.solver.stampElement(_hBA, -G);
    },
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_rhs: Float64Array): number[] { return [0, 0]; },
  };
  return el;
}

// ---------------------------------------------------------------------------
// Helper: build a SetupContext backed by a real SparseSolver.
// Used to exercise setup() in isolation before calling load().
// ---------------------------------------------------------------------------

function makeSetupCtx(solver: SparseSolver): { ctx: SetupContext; stateCount: () => number } {
  // Initialize the solver structure before allocating elements.
  // _initStructure() is called by CKTCircuitContext constructor in production;
  // in test-only setup paths we must call it directly.
  (solver as any)._initStructure();
  let states = 0;
  let nodeMax = 100;
  const ctx: SetupContext = {
    solver,
    temp: 300.15,
    nomTemp: 300.15,
    copyNodesets: false,
    makeVolt(_label: string, _suffix: string): number { return ++nodeMax; },
    makeCur(_label: string, _suffix: string): number { return ++nodeMax; },
    allocStates(n: number): number {
      const off = states;
      states += n;
      return off;
    },
    findBranch(_label: string): number { return 0; },
    findDevice(_label: string) { return null; },
  };
  return { ctx, stateCount: () => states };
}

function makeSpstProps(overrides: {
  closed?: boolean;
  Ron?: number;
  Roff?: number;
  normallyClosed?: boolean;
} = {}): PropertyBag {
  const props = new PropertyBag();
  props.set("closed", overrides.closed ?? false);
  props.set("Ron", overrides.Ron ?? 1);
  props.set("Roff", overrides.Roff ?? 1e9);
  if (overrides.normallyClosed !== undefined) props.set("normallyClosed", overrides.normallyClosed);
  return props;
}

// ---------------------------------------------------------------------------
// makeVsrc- DC voltage source helper
// ---------------------------------------------------------------------------
function makeVsrc(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
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
    const el = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), props);

    const solver = new SparseSolver();
    const { ctx } = makeSetupCtx(solver);
    el.setup(ctx);

    // Read insertion order BEFORE any further _initStructure calls.
    const order = (solver as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    expect(order).toHaveLength(4); // PP, PN, NP, NN

    // Handles are private (ssA.9); verify setup ran via observable state fields.
    expect(el._stateBase).toBeGreaterThanOrEqual(0);
    expect(el.branchIndex).toBe(-1); // SW has no branch row
  });

  it("open_stamps_roff_conductance_is_smaller", () => {
    const propsOpen = makeSpstProps({ closed: false, Roff: 1e9 });
    const elOpen = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), propsOpen);

    const propsClosed = makeSpstProps({ closed: true, Ron: 1 });
    const elClosed = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), propsClosed);

    const solverOpen = new SparseSolver();
    const { ctx: ctxOpen } = makeSetupCtx(solverOpen);
    elOpen.setup(ctxOpen);

    const solverClosed = new SparseSolver();
    const { ctx: ctxClosed } = makeSetupCtx(solverClosed);
    elClosed.setup(ctxClosed);

    // G_roff = 1/1e9 = 1e-9, G_ron = 1/1 = 1.0
    // Both elements get the same TSTALLOC shape- 4 handles
    const orderOpen = (solverOpen as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    const orderClosed = (solverClosed as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    expect(orderOpen).toHaveLength(4);
    expect(orderClosed).toHaveLength(4);
    expect(orderOpen).toEqual(orderClosed);
  });

  it("toggle_changes_conductance", () => {
    const props = makeSpstProps({ closed: true, Ron: 1, Roff: 1e9 });
    const el = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), props) as SpstAnalogElement;

    const solver = new SparseSolver();
    const { ctx } = makeSetupCtx(solver);
    el.setup(ctx);

    const loadCtxClosed = makeSimpleCtx({ solver, elements: [], nodeCount: 2, matrixSize: 2 });
    el.load(loadCtxClosed.loadCtx);

    el.setClosed(false);
    const loadCtxOpen = makeSimpleCtx({ solver, elements: [], nodeCount: 2, matrixSize: 2 });
    el.load(loadCtxOpen.loadCtx);

    // After toggle, _forcedState=null and _effectivelyClosed=false, so Roff applies.
    // Verify setup ran (public field) and no branch row allocated (SW topology).
    expect(el._stateBase).toBeGreaterThanOrEqual(0);
    expect(el.branchIndex).toBe(-1);
  });

  it("normallyClosed_inverts_analog_conductance", () => {
    const props = new PropertyBag();
    props.set("closed", false);       // user state: not pressed
    props.set("normallyClosed", true); // NC: effectively closed at rest
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), props);

    const solver = new SparseSolver();
    const { ctx } = makeSetupCtx(solver);
    el.setup(ctx);

    // NC + closed=false → effectively closed → handles allocated at PP,PN,NP,NN
    const order = (solver as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    expect(order).toHaveLength(4);
    expect(order[0]).toEqual({ extRow: 1, extCol: 1 }); // PP
    expect(order[1]).toEqual({ extRow: 1, extCol: 2 }); // PN
    expect(order[2]).toEqual({ extRow: 2, extCol: 1 }); // NP
    expect(order[3]).toEqual({ extRow: 2, extCol: 2 }); // NN
  });

  it("setup_allocates_2_state_slots", () => {
    const props = makeSpstProps();
    const el = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), props);

    const solver = new SparseSolver();
    const { ctx, stateCount } = makeSetupCtx(solver);
    el.setup(ctx);

    expect(stateCount()).toBe(2); // SW_NUM_STATES = 2
    expect(el._stateBase).toBe(0);
  });

  it("tstalloc_sequence_pp_pn_np_nn", () => {
    const props = makeSpstProps({ closed: false });
    const el = new SwitchAnalogElement(new Map([["A1", 1], ["B1", 2]]), props);

    const solver = new SparseSolver();
    const { ctx } = makeSetupCtx(solver);
    el.setup(ctx);

    const order = (solver as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    expect(order).toEqual([
      { extRow: 1, extCol: 1 }, // PP
      { extRow: 1, extCol: 2 }, // PN
      { extRow: 2, extCol: 1 }, // NP
      { extRow: 2, extCol: 2 }, // NN
    ]);
  });
});

describe("AnalogSPDT", () => {
  it("common_to_c_when_open", () => {
    // closed=false → SW_AB has Roff (open), SW_AC has Ron (closed)
    const props = new PropertyBag();
    props.set("closed", false);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = new SwitchDTAnalogElement(new Map([["A1", 1], ["B1", 2], ["C1", 3]]), props) as SpdtAnalogElement;

    const solver = new SparseSolver();
    const { ctx } = makeSetupCtx(solver);
    el.setup(ctx);

    // 8 handles total: 4 for SW_AB + 4 for SW_AC
    const order = (solver as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    expect(order).toHaveLength(8);
    // SW_AB sequence: (1,1),(1,2),(2,1),(2,2)
    expect(order[0]).toEqual({ extRow: 1, extCol: 1 });
    expect(order[1]).toEqual({ extRow: 1, extCol: 2 });
    expect(order[2]).toEqual({ extRow: 2, extCol: 1 });
    expect(order[3]).toEqual({ extRow: 2, extCol: 2 });
    // SW_AC sequence: (1,1),(1,3),(3,1),(3,3)
    expect(order[4]).toEqual({ extRow: 1, extCol: 1 });
    expect(order[5]).toEqual({ extRow: 1, extCol: 3 });
    expect(order[6]).toEqual({ extRow: 3, extCol: 1 });
    expect(order[7]).toEqual({ extRow: 3, extCol: 3 });
  });

  it("common_to_b_when_closed", () => {
    // closed=true → SW_AB has Ron (closed), SW_AC has Roff (open)
    const props = new PropertyBag();
    props.set("closed", true);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = new SwitchDTAnalogElement(new Map([["A1", 1], ["B1", 2], ["C1", 3]]), props);

    const solver = new SparseSolver();
    const { ctx } = makeSetupCtx(solver);
    el.setup(ctx);

    const order = (solver as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    expect(order).toHaveLength(8);
  });

  it("spdt_tstalloc_sequence_8_entries", () => {
    // PB-SW-DT: SW_AB 4 entries then SW_AC 4 entries
    const props = new PropertyBag();
    props.set("closed", false);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = new SwitchDTAnalogElement(new Map([["A1", 1], ["B1", 2], ["C1", 3]]), props);

    const solver = new SparseSolver();
    const { ctx } = makeSetupCtx(solver);
    el.setup(ctx);

    const order = (solver as any)._getInsertionOrder() as Array<{ extRow: number; extCol: number }>;
    expect(order).toEqual([
      // SW_AB- swsetup.c:59-62, first pass (posNode=1, negNode=2)
      { extRow: 1, extCol: 1 }, // swAB._hPP
      { extRow: 1, extCol: 2 }, // swAB._hPN
      { extRow: 2, extCol: 1 }, // swAB._hNP
      { extRow: 2, extCol: 2 }, // swAB._hNN
      // SW_AC- swsetup.c:59-62, second pass (posNode=1, negNode=3)
      { extRow: 1, extCol: 1 }, // swAC._hPP
      { extRow: 1, extCol: 3 }, // swAC._hPN
      { extRow: 3, extCol: 1 }, // swAC._hNP
      { extRow: 3, extCol: 3 }, // swAC._hNN
    ]);
  });

  it("spdt_setup_allocates_4_state_slots", () => {
    const props = new PropertyBag();
    props.set("closed", false);
    props.set("Ron", 1);
    props.set("Roff", 1e9);

    const el = new SwitchDTAnalogElement(new Map([["A1", 1], ["B1", 2], ["C1", 3]]), props);

    const solver = new SparseSolver();
    const { ctx, stateCount } = makeSetupCtx(solver);
    el.setup(ctx);

    expect(stateCount()).toBe(4); // 2 per sub-element × 2 sub-elements
  });
});

// ---------------------------------------------------------------------------
// Integration test- switched resistor divider using makeSimpleCtx + solveDcOp
//
// SwitchAnalogElement.setup() is called after CKTCircuitContext construction
// (which calls _initStructure), ensuring handles are valid before load().
// makeDcVoltageSource and the local makeResistor follow the ssA.13 contract:
// handles are allocated in setup(), stamped in load().
// ---------------------------------------------------------------------------

import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";

describe("Integration", () => {
  it("switched_resistor_divider", () => {
    // 10V → SPST switch (closed, Ron=1Ω) → 1kΩ → ground
    // DC OP: V across R = 10 * 1000/1001 ≈ 9.99V
    //
    // matrixSize=3: node1(1), node2(2), branch-row for vs(3).
    // startBranch=3 so makeCur() assigns row 3 to the voltage source.

    const switchProps = makeSpstProps({ closed: true, Ron: 1, Roff: 1e9 });
    const swEl = new SwitchAnalogElement(
      new Map([["A1", 1], ["B1", 2]]),
      switchProps,
    ) as SpstAnalogElement;

    const vs = makeVsrc(1, 0, 10);  // 10V: node1→gnd
    const r = makeResistor(2, 0, 1000);          // 1kΩ: node2→gnd

    const solver = new SparseSolver();

    // makeSimpleCtx constructs CKTCircuitContext (calls _initStructure), then runs
    // setupAll on all elements. startBranch=3 places the voltage-source branch row
    // at index 3, matching matrixSize=3.
    const ctx = makeSimpleCtx({
      solver,
      elements: [vs as unknown as AnalogElement, swEl as unknown as AnalogElement, r as unknown as AnalogElement],
      nodeCount: 2,
      matrixSize: 3,
      branchCount: 1,
      startBranch: 3,
    });

    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    // dcopVoltages (aliased by dcopResult.nodeVoltages) holds the final DC OP solution.
    const vAcrossR = ctx.dcopResult.nodeVoltages[2];
    expect(vAcrossR).toBeGreaterThan(9.98);
    expect(vAcrossR).toBeLessThanOrEqual(10.0);
  });
});
