/**
 * Tests for PLD components: Diode, DiodeForward, DiodeBackward, PullUp, PullDown.
 *
 * Covers per the task spec:
 *   - Diode forward conduction
 *   - Pull-up on floating net
 *   - Pull-down on floating net
 *   - Rendering for each component
 *   - Attribute mapping correctness
 *   - ComponentDefinition completeness for all variants
 *   - Registry registration
 */

import { describe, it, expect } from "vitest";
import {
  DiodeElement,
  DiodeForwardElement,
  DiodeBackwardElement,
  executeDiode,
  executeDiodeForward,
  executeDiodeBackward,
  DiodeDefinition,
  DiodeForwardDefinition,
  DiodeBackwardDefinition,
  DIODE_ATTRIBUTE_MAPPINGS_EXPORT,
} from "../diode.js";
import {
  PullUpElement,
  executePullUp,
  PullUpDefinition,
  PULL_UP_ATTRIBUTE_MAPPINGS,
} from "../pull-up.js";
import {
  PullDownElement,
  executePullDown,
  PullDownDefinition,
  PULL_DOWN_ATTRIBUTE_MAPPINGS,
} from "../pull-down.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

function makeLayoutSingle(inputOffset: number, outputOffset: number): ComponentLayout {
  return {
    inputCount: () => 1,
    inputOffset: () => inputOffset,
    outputCount: () => 1,
    outputOffset: () => outputOffset,
    stateOffset: () => 0,
  };
}

function makeState(size: number, fill: number = 0): Uint32Array {
  return new Uint32Array(size).fill(fill);
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

function makeDiode(overrides?: { blown?: boolean; label?: string }): DiodeElement {
  const props = new PropertyBag();
  props.set("blown", overrides?.blown ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new DiodeElement("test-diode-001", { x: 0, y: 0 }, 0, false, props);
}

function makeDiodeForward(overrides?: { blown?: boolean; label?: string }): DiodeForwardElement {
  const props = new PropertyBag();
  props.set("blown", overrides?.blown ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new DiodeForwardElement("test-df-001", { x: 0, y: 0 }, 0, false, props);
}

function makeDiodeBackward(overrides?: { blown?: boolean; label?: string }): DiodeBackwardElement {
  const props = new PropertyBag();
  props.set("blown", overrides?.blown ?? false);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new DiodeBackwardElement("test-db-001", { x: 0, y: 0 }, 0, false, props);
}

function makePullUp(overrides?: { bitWidth?: number; label?: string }): PullUpElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new PullUpElement("test-pu-001", { x: 0, y: 0 }, 0, false, props);
}

function makePullDown(overrides?: { bitWidth?: number; label?: string }): PullDownElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new PullDownElement("test-pd-001", { x: 0, y: 0 }, 0, false, props);
}

// ===========================================================================
// Diode tests
// ===========================================================================

describe("Diode", () => {
  // -------------------------------------------------------------------------
  // Pin layout
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("Diode has 2 pins", () => {
      const d = makeDiode();
      expect(d.getPins()).toHaveLength(2);
    });

    it("Diode pins are labeled 'cathode' and 'anode'", () => {
      const d = makeDiode();
      const labels = d.getPins().map((p) => p.label);
      expect(labels).toContain("cathode");
      expect(labels).toContain("anode");
    });

    it("Diode pins are BIDIRECTIONAL", () => {
      const d = makeDiode();
      for (const pin of d.getPins()) {
        expect(pin.direction).toBe(PinDirection.BIDIRECTIONAL);
      }
    });

    it("DiodeDefinition.pinLayout has 2 entries", () => {
      expect(DiodeDefinition.pinLayout).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Forward conduction — anode drives cathode high
  // -------------------------------------------------------------------------

  describe("forwardConduction", () => {
    it("anode high (not highZ) → cathode driven to 1", () => {
      // inputStart=0: cathodeIn=state[0], anodeIn=state[1]
      // outputStart=2: cathodeOut=state[2], cathodeHighZ=state[3], anodeOut=state[4] (blown), ...
      // Use 8-slot layout to avoid overlap
      const layout: ComponentLayout = {
        inputCount: () => 2,
        inputOffset: () => 0,
        outputCount: () => 5,
        outputOffset: () => 2,
        stateOffset: () => 7,
      };
      const state = makeState(10);
      const highZs = new Uint32Array(state.length);
      // cathodeIn = highZ (slot 0): value=0, highZ=1 → encode as (1 << 16) | 0
      state[0] = (1 << 16) | 0;
      // anodeIn = driven high: value=1, highZ=0 → encode as 0 | 1
      state[1] = 1;
      // blown flag at outputStart+4 = state[6] = 0 (not blown)
      state[6] = 0;

      executeDiode(0, state, highZs, layout);

      // cathode output slot (outputStart=2): state[2]=driven value, state[3]=highZ
      expect(state[2]).toBe(1);
      expect(state[3]).toBe(0); // not highZ — actively driven
    });

    it("anode low (not highZ) → cathode is high-Z (not driven)", () => {
      const layout: ComponentLayout = {
        inputCount: () => 2,
        inputOffset: () => 0,
        outputCount: () => 5,
        outputOffset: () => 2,
        stateOffset: () => 7,
      };
      const state = makeState(10);
      const highZs = new Uint32Array(state.length);
      state[0] = (1 << 16) | 0; // cathodeIn = highZ
      state[1] = 0;             // anodeIn = 0, not highZ
      state[6] = 0;             // not blown

      executeDiode(0, state, highZs, layout);

      expect(state[3]).toBe(1); // cathode is high-Z (diode not conducting forward)
    });

    it("cathode low (not highZ) → anode is driven to 0 (pulling down)", () => {
      const layout: ComponentLayout = {
        inputCount: () => 2,
        inputOffset: () => 0,
        outputCount: () => 5,
        outputOffset: () => 2,
        stateOffset: () => 7,
      };
      const state = makeState(10);
      const highZs = new Uint32Array(state.length);
      state[0] = 0;             // cathodeIn = 0, not highZ (driven low)
      state[1] = (1 << 16) | 0; // anodeIn = highZ
      state[6] = 0;             // not blown

      executeDiode(0, state, highZs, layout);

      expect(state[4]).toBe(0); // anode driven to 0
      expect(state[5]).toBe(0); // not highZ — actively pulling anode low
    });

    it("cathode highZ → anode is high-Z (not pulling)", () => {
      const layout: ComponentLayout = {
        inputCount: () => 2,
        inputOffset: () => 0,
        outputCount: () => 5,
        outputOffset: () => 2,
        stateOffset: () => 7,
      };
      const state = makeState(10);
      const highZs = new Uint32Array(state.length);
      state[0] = (1 << 16) | 0; // cathodeIn = highZ
      state[1] = (1 << 16) | 0; // anodeIn = highZ
      state[6] = 0;              // not blown

      executeDiode(0, state, highZs, layout);

      expect(state[5]).toBe(1); // anode is high-Z
    });

    it("blown diode — both outputs are high-Z", () => {
      const layout: ComponentLayout = {
        inputCount: () => 2,
        inputOffset: () => 0,
        outputCount: () => 5,
        outputOffset: () => 2,
        stateOffset: () => 7,
      };
      const state = makeState(10);
      const highZs = new Uint32Array(state.length);
      state[0] = 0;  // cathodeIn = 0 (driven low)
      state[1] = 1;  // anodeIn = 1 (driven high)
      state[6] = 1;  // blown flag set

      executeDiode(0, state, highZs, layout);

      expect(state[3]).toBe(1); // cathode high-Z
      expect(state[5]).toBe(1); // anode high-Z
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawPath for the diode triangle", () => {
      const d = makeDiode();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawPath").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawLine for lead wires and cathode bar", () => {
      const d = makeDiode();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawLine").length).toBeGreaterThanOrEqual(3);
    });

    it("draw() with label calls drawText", () => {
      const d = makeDiode({ label: "D1" });
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "D1")).toBe(true);
    });

    it("draw() without label does not call drawText", () => {
      const d = makeDiode();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText")).toHaveLength(0);
    });

    it("blown diode draw() calls setColor ERROR for the blow mark", () => {
      const d = makeDiode({ blown: true });
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      const errorColor = calls.filter(
        (c) => c.method === "setColor" && c.args[0] === "ERROR",
      );
      expect(errorColor.length).toBeGreaterThanOrEqual(1);
    });

    it("non-blown diode draw() does not call setColor ERROR", () => {
      const d = makeDiode({ blown: false });
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      const errorColor = calls.filter(
        (c) => c.method === "setColor" && c.args[0] === "ERROR",
      );
      expect(errorColor).toHaveLength(0);
    });

    it("draw() saves and restores context", () => {
      const d = makeDiode();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "save")).toHaveLength(1);
      expect(calls.filter((c) => c.method === "restore")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Blown flag
  // -------------------------------------------------------------------------

  describe("blownFlag", () => {
    it("default Diode is not blown", () => {
      const d = makeDiode();
      expect(d.isBlown()).toBe(false);
    });

    it("Diode with blown=true reports isBlown()=true", () => {
      const d = makeDiode({ blown: true });
      expect(d.isBlown()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Bounding box
  // -------------------------------------------------------------------------

  describe("boundingBox", () => {
    it("getBoundingBox returns correct dimensions", () => {
      const d = makeDiode();
      const bb = d.getBoundingBox();
      expect(bb.x).toBe(0);
      expect(bb.y).toBe(0);
      expect(bb.width).toBeGreaterThanOrEqual(2);
      expect(bb.height).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("blown=true maps to boolean true", () => {
      const mapping = DIODE_ATTRIBUTE_MAPPINGS_EXPORT.find((m) => m.xmlName === "blown");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("true")).toBe(true);
    });

    it("blown=false maps to boolean false", () => {
      const mapping = DIODE_ATTRIBUTE_MAPPINGS_EXPORT.find((m) => m.xmlName === "blown");
      expect(mapping!.convert("false")).toBe(false);
    });

    it("Label maps to label property", () => {
      const mapping = DIODE_ATTRIBUTE_MAPPINGS_EXPORT.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("D1")).toBe("D1");
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("DiodeDefinition has name='Diode'", () => {
      expect(DiodeDefinition.name).toBe("Diode");
    });

    it("DiodeDefinition has typeId=-1", () => {
      expect(DiodeDefinition.typeId).toBe(-1);
    });

    it("DiodeDefinition has a factory function", () => {
      expect(typeof DiodeDefinition.factory).toBe("function");
    });

    it("DiodeDefinition factory produces a DiodeElement", () => {
      const props = new PropertyBag();
      props.set("blown", false);
      const el = DiodeDefinition.factory(props);
      expect(el.typeId).toBe("Diode");
    });

    it("DiodeDefinition has executeFn=executeDiode", () => {
      expect(DiodeDefinition.executeFn).toBe(executeDiode);
    });

    it("DiodeDefinition category is PLD", () => {
      expect(DiodeDefinition.category).toBe(ComponentCategory.PLD);
    });

    it("DiodeDefinition has non-empty helpText", () => {
      expect(typeof DiodeDefinition.helpText).toBe("string");
      expect(typeof DiodeDefinition.helpText).toBe("string"); expect(DiodeDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("DiodeDefinition has non-empty propertyDefs", () => {
      expect(DiodeDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("DiodeDefinition propertyDefs include 'blown'", () => {
      const keys = DiodeDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("blown");
    });

    it("DiodeDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DiodeDefinition)).not.toThrow();
    });

    it("After registration DiodeDefinition typeId is non-negative", () => {
      const registry = new ComponentRegistry();
      registry.register(DiodeDefinition);
      const registered = registry.get("Diode");
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });

    it("DiodeDefinition defaultDelay is 0", () => {
      expect(DiodeDefinition.defaultDelay).toBe(0);
    });
  });
});

// ===========================================================================
// DiodeForward tests
// ===========================================================================

describe("DiodeForward", () => {
  // -------------------------------------------------------------------------
  // Pin layout
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("DiodeForward has 2 pins", () => {
      const d = makeDiodeForward();
      expect(d.getPins()).toHaveLength(2);
    });

    it("DiodeForward pins are labeled 'in' and 'out'", () => {
      const d = makeDiodeForward();
      const labels = d.getPins().map((p) => p.label);
      expect(labels).toContain("in");
      expect(labels).toContain("out");
    });

    it("'in' pin is INPUT direction", () => {
      const d = makeDiodeForward();
      const inPin = d.getPins().find((p) => p.label === "in");
      expect(inPin!.direction).toBe(PinDirection.INPUT);
    });

    it("'out' pin is OUTPUT direction", () => {
      const d = makeDiodeForward();
      const outPin = d.getPins().find((p) => p.label === "out");
      expect(outPin!.direction).toBe(PinDirection.OUTPUT);
    });

    it("DiodeForwardDefinition.pinLayout has 2 entries", () => {
      expect(DiodeForwardDefinition.pinLayout).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Forward conduction — in=1 → out=1; in=0 → out=highZ
  // -------------------------------------------------------------------------

  describe("forwardConduction", () => {
    it("in=1 → output driven to 1 (highZ=0)", () => {
      // inputOffset=0, outputOffset=1; blown flag at output+2=state[3]
      const layout: ComponentLayout = {
        inputCount: () => 1,
        inputOffset: () => 0,
        outputCount: () => 3,
        outputOffset: () => 1,
        stateOffset: () => 4,
      };
      const state = makeState(6);
      const highZs = new Uint32Array(state.length);
      state[0] = 1; // in=1
      state[3] = 0; // not blown

      executeDiodeForward(0, state, highZs, layout);

      expect(state[1]).toBe(1); // out=1
      expect(state[2]).toBe(0); // highZ=0 (actively driven)
    });

    it("in=0 → output is high-Z", () => {
      const layout: ComponentLayout = {
        inputCount: () => 1,
        inputOffset: () => 0,
        outputCount: () => 3,
        outputOffset: () => 1,
        stateOffset: () => 4,
      };
      const state = makeState(6);
      const highZs = new Uint32Array(state.length);
      state[0] = 0; // in=0
      state[3] = 0; // not blown

      executeDiodeForward(0, state, highZs, layout);

      expect(state[2]).toBe(1); // highZ=1 (high-Z)
    });

    it("blown=true → output always high-Z regardless of input", () => {
      const layout: ComponentLayout = {
        inputCount: () => 1,
        inputOffset: () => 0,
        outputCount: () => 3,
        outputOffset: () => 1,
        stateOffset: () => 4,
      };
      const state = makeState(6);
      const highZs = new Uint32Array(state.length);
      state[0] = 1; // in=1 (would normally drive output)
      state[3] = 1; // blown

      executeDiodeForward(0, state, highZs, layout);

      expect(state[2]).toBe(1); // high-Z regardless
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawPath for the diode triangle body", () => {
      const d = makeDiodeForward();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawPath").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawLine for lead wires and cathode bar", () => {
      const d = makeDiodeForward();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawLine").length).toBeGreaterThanOrEqual(3);
    });

    it("draw() with label calls drawText", () => {
      const d = makeDiodeForward({ label: "DF1" });
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "DF1")).toBe(true);
    });

    it("blown DiodeForward draw() shows ERROR color marker", () => {
      const d = makeDiodeForward({ blown: true });
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "setColor" && c.args[0] === "ERROR").length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("blown=true maps to boolean true", () => {
      const mapping = DiodeForwardDefinition.attributeMap.find((m) => m.xmlName === "blown");
      expect(mapping!.convert("true")).toBe(true);
    });

    it("Label maps to label property key", () => {
      const mapping = DiodeForwardDefinition.attributeMap.find((m) => m.xmlName === "Label");
      expect(mapping!.propertyKey).toBe("label");
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("DiodeForwardDefinition has name='DiodeForward'", () => {
      expect(DiodeForwardDefinition.name).toBe("DiodeForward");
    });

    it("DiodeForwardDefinition has typeId=-1", () => {
      expect(DiodeForwardDefinition.typeId).toBe(-1);
    });

    it("DiodeForwardDefinition executeFn is executeDiodeForward", () => {
      expect(DiodeForwardDefinition.executeFn).toBe(executeDiodeForward);
    });

    it("DiodeForwardDefinition category is PLD", () => {
      expect(DiodeForwardDefinition.category).toBe(ComponentCategory.PLD);
    });

    it("DiodeForwardDefinition factory produces a DiodeForwardElement", () => {
      const props = new PropertyBag();
      props.set("blown", false);
      const el = DiodeForwardDefinition.factory(props);
      expect(el.typeId).toBe("DiodeForward");
    });

    it("DiodeForwardDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DiodeForwardDefinition)).not.toThrow();
    });

    it("DiodeForwardDefinition has non-empty helpText", () => {
      expect(typeof DiodeForwardDefinition.helpText).toBe("string"); expect(DiodeForwardDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("DiodeForwardDefinition defaultDelay is 0", () => {
      expect(DiodeForwardDefinition.defaultDelay).toBe(0);
    });
  });
});

// ===========================================================================
// DiodeBackward tests
// ===========================================================================

describe("DiodeBackward", () => {
  // -------------------------------------------------------------------------
  // Pin layout
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("DiodeBackward has 2 pins", () => {
      const d = makeDiodeBackward();
      expect(d.getPins()).toHaveLength(2);
    });

    it("DiodeBackward has 'in' and 'out' pins", () => {
      const d = makeDiodeBackward();
      const labels = d.getPins().map((p) => p.label);
      expect(labels).toContain("in");
      expect(labels).toContain("out");
    });

    it("DiodeBackwardDefinition.pinLayout has 2 entries", () => {
      expect(DiodeBackwardDefinition.pinLayout).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Backward conduction — in=1 → out=1; in=0 → out=0
  // -------------------------------------------------------------------------

  describe("backwardConduction", () => {
    it("in=1 → output driven to 1 (contributes to pull-up net)", () => {
      const layout: ComponentLayout = {
        inputCount: () => 1,
        inputOffset: () => 0,
        outputCount: () => 3,
        outputOffset: () => 1,
        stateOffset: () => 4,
      };
      const state = makeState(6);
      const highZs = new Uint32Array(state.length);
      state[0] = 1; // in=1
      state[3] = 0; // not blown

      executeDiodeBackward(0, state, highZs, layout);

      expect(state[1]).toBe(1); // out=1
      expect(state[2]).toBe(0); // not high-Z
    });

    it("in=0 → output driven to 0 (pulls down the pull-up net)", () => {
      const layout: ComponentLayout = {
        inputCount: () => 1,
        inputOffset: () => 0,
        outputCount: () => 3,
        outputOffset: () => 1,
        stateOffset: () => 4,
      };
      const state = makeState(6);
      const highZs = new Uint32Array(state.length);
      state[0] = 0; // in=0
      state[3] = 0; // not blown

      executeDiodeBackward(0, state, highZs, layout);

      expect(state[1]).toBe(0); // out=0 (actively pulling down)
      expect(state[2]).toBe(0); // not high-Z — actively driven
    });

    it("blown=true → output always high-Z", () => {
      const layout: ComponentLayout = {
        inputCount: () => 1,
        inputOffset: () => 0,
        outputCount: () => 3,
        outputOffset: () => 1,
        stateOffset: () => 4,
      };
      const state = makeState(6);
      const highZs = new Uint32Array(state.length);
      state[0] = 1; // in=1 (would normally drive output)
      state[3] = 1; // blown

      executeDiodeBackward(0, state, highZs, layout);

      expect(state[2]).toBe(1); // high-Z (blown)
    });

    it("DiodeBackward vs DiodeForward: backward drives 0 when in=0, forward does not", () => {
      const layout: ComponentLayout = {
        inputCount: () => 1,
        inputOffset: () => 0,
        outputCount: () => 3,
        outputOffset: () => 1,
        stateOffset: () => 4,
      };
      const stateBackward = makeState(6);
      stateBackward[0] = 0;
      stateBackward[3] = 0;
      executeDiodeBackward(0, stateBackward, new Uint32Array(stateBackward.length), layout);

      const stateForward = makeState(6);
      stateForward[0] = 0;
      stateForward[3] = 0;
      executeDiodeForward(0, stateForward, new Uint32Array(stateForward.length), layout);

      // Backward: drives 0 actively
      expect(stateBackward[2]).toBe(0); // not high-Z
      // Forward: goes high-Z
      expect(stateForward[2]).toBe(1); // high-Z
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawPath for backward-oriented diode triangle", () => {
      const d = makeDiodeBackward();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawPath").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawLine for the cathode bar and lead wires", () => {
      const d = makeDiodeBackward();
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawLine").length).toBeGreaterThanOrEqual(3);
    });

    it("draw() with label calls drawText", () => {
      const d = makeDiodeBackward({ label: "DB1" });
      const { ctx, calls } = makeStubCtx();
      d.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "DB1")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("DiodeBackwardDefinition has name='DiodeBackward'", () => {
      expect(DiodeBackwardDefinition.name).toBe("DiodeBackward");
    });

    it("DiodeBackwardDefinition has typeId=-1", () => {
      expect(DiodeBackwardDefinition.typeId).toBe(-1);
    });

    it("DiodeBackwardDefinition executeFn is executeDiodeBackward", () => {
      expect(DiodeBackwardDefinition.executeFn).toBe(executeDiodeBackward);
    });

    it("DiodeBackwardDefinition category is PLD", () => {
      expect(DiodeBackwardDefinition.category).toBe(ComponentCategory.PLD);
    });

    it("DiodeBackwardDefinition factory produces a DiodeBackwardElement", () => {
      const props = new PropertyBag();
      props.set("blown", false);
      const el = DiodeBackwardDefinition.factory(props);
      expect(el.typeId).toBe("DiodeBackward");
    });

    it("DiodeBackwardDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DiodeBackwardDefinition)).not.toThrow();
    });

    it("DiodeBackwardDefinition defaultDelay is 0", () => {
      expect(DiodeBackwardDefinition.defaultDelay).toBe(0);
    });
  });
});

// ===========================================================================
// PullUp tests
// ===========================================================================

describe("PullUp", () => {
  // -------------------------------------------------------------------------
  // Pin layout
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("PullUp has 1 pin", () => {
      const pu = makePullUp();
      expect(pu.getPins()).toHaveLength(1);
    });

    it("PullUp pin is labeled 'out'", () => {
      const pu = makePullUp();
      expect(pu.getPins()[0].label).toBe("out");
    });

    it("PullUp 'out' pin is OUTPUT direction", () => {
      const pu = makePullUp();
      expect(pu.getPins()[0].direction).toBe(PinDirection.OUTPUT);
    });

    it("PullUpDefinition.pinLayout has 1 entry", () => {
      expect(PullUpDefinition.pinLayout).toHaveLength(1);
    });

    it("1-bit PullUp output pin has bitWidth=1", () => {
      const pu = makePullUp({ bitWidth: 1 });
      expect(pu.getPins()[0].bitWidth).toBe(1);
    });

    it("4-bit PullUp output pin has bitWidth=4", () => {
      const pu = makePullUp({ bitWidth: 4 });
      expect(pu.getPins()[0].bitWidth).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // executePullUp — pulls floating net to 1
  // -------------------------------------------------------------------------

  describe("pullUpOnFloatingNet", () => {
    it("executePullUp writes 0xFFFFFFFF to output slot", () => {
      const layout = makeLayoutSingle(0, 0);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      executePullUp(0, state, highZs, layout);
      expect(state[0]).toBe(0xFFFFFFFF);
    });

    it("executePullUp can be called 1000 times without error", () => {
      const layout = makeLayoutSingle(0, 0);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        executePullUp(0, state, highZs, layout);
      }
      expect(state[0]).toBe(0xFFFFFFFF);
    });

    it("executePullUp always writes all-ones regardless of prior state", () => {
      const layout = makeLayoutSingle(0, 0);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 0;
      executePullUp(0, state, highZs, layout);
      expect(state[0]).toBe(0xFFFFFFFF);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawLine for VDD rail", () => {
      const pu = makePullUp();
      const { ctx, calls } = makeStubCtx();
      pu.draw(ctx);
      expect(calls.filter((c) => c.method === "drawLine").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawPath for the resistor zigzag body", () => {
      const pu = makePullUp();
      const { ctx, calls } = makeStubCtx();
      pu.draw(ctx);
      expect(calls.filter((c) => c.method === "drawPath").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() with label calls drawText", () => {
      const pu = makePullUp({ label: "R1" });
      const { ctx, calls } = makeStubCtx();
      pu.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "R1")).toBe(true);
    });

    it("draw() without label does not call drawText", () => {
      const pu = makePullUp();
      const { ctx, calls } = makeStubCtx();
      pu.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText")).toHaveLength(0);
    });

    it("draw() saves and restores context", () => {
      const pu = makePullUp();
      const { ctx, calls } = makeStubCtx();
      pu.draw(ctx);
      expect(calls.filter((c) => c.method === "save")).toHaveLength(1);
      expect(calls.filter((c) => c.method === "restore")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Bounding box
  // -------------------------------------------------------------------------

  describe("boundingBox", () => {
    it("getBoundingBox returns non-zero dimensions", () => {
      const pu = makePullUp();
      const bb = pu.getBoundingBox();
      expect(bb.width).toBeGreaterThanOrEqual(1);
      expect(bb.height).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits=8 maps to bitWidth=8", () => {
      const mapping = PULL_UP_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("8")).toBe(8);
    });

    it("Bits=1 maps to bitWidth=1", () => {
      const mapping = PULL_UP_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("1")).toBe(1);
    });

    it("Label maps to label property", () => {
      const mapping = PULL_UP_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("R1")).toBe("R1");
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("PullUpDefinition has name='PullUp'", () => {
      expect(PullUpDefinition.name).toBe("PullUp");
    });

    it("PullUpDefinition has typeId=-1", () => {
      expect(PullUpDefinition.typeId).toBe(-1);
    });

    it("PullUpDefinition has a factory function", () => {
      expect(typeof PullUpDefinition.factory).toBe("function");
    });

    it("PullUpDefinition factory produces a PullUpElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = PullUpDefinition.factory(props);
      expect(el.typeId).toBe("PullUp");
    });

    it("PullUpDefinition has executeFn=executePullUp", () => {
      expect(PullUpDefinition.executeFn).toBe(executePullUp);
    });

    it("PullUpDefinition category is PLD", () => {
      expect(PullUpDefinition.category).toBe(ComponentCategory.PLD);
    });

    it("PullUpDefinition has non-empty helpText", () => {
      expect(typeof PullUpDefinition.helpText).toBe("string"); expect(PullUpDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("PullUpDefinition has non-empty propertyDefs", () => {
      expect(PullUpDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("PullUpDefinition propertyDefs include 'bitWidth'", () => {
      const keys = PullUpDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
    });

    it("PullUpDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PullUpDefinition)).not.toThrow();
    });

    it("After registration PullUp typeId is non-negative", () => {
      const registry = new ComponentRegistry();
      registry.register(PullUpDefinition);
      const registered = registry.get("PullUp");
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });

    it("PullUpDefinition defaultDelay is 0", () => {
      expect(PullUpDefinition.defaultDelay).toBe(0);
    });

    it("PullUpDefinition helpText mentions 'logic 1' or 'VDD'", () => {
      const text = PullUpDefinition.helpText;
      expect(text.includes("logic 1") || text.includes("VDD")).toBe(true);
    });
  });
});

// ===========================================================================
// PullDown tests
// ===========================================================================

describe("PullDown", () => {
  // -------------------------------------------------------------------------
  // Pin layout
  // -------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("PullDown has 1 pin", () => {
      const pd = makePullDown();
      expect(pd.getPins()).toHaveLength(1);
    });

    it("PullDown pin is labeled 'out'", () => {
      const pd = makePullDown();
      expect(pd.getPins()[0].label).toBe("out");
    });

    it("PullDown 'out' pin is OUTPUT direction", () => {
      const pd = makePullDown();
      expect(pd.getPins()[0].direction).toBe(PinDirection.OUTPUT);
    });

    it("PullDownDefinition.pinLayout has 1 entry", () => {
      expect(PullDownDefinition.pinLayout).toHaveLength(1);
    });

    it("8-bit PullDown output pin has bitWidth=8", () => {
      const pd = makePullDown({ bitWidth: 8 });
      expect(pd.getPins()[0].bitWidth).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  // executePullDown — pulls floating net to 0
  // -------------------------------------------------------------------------

  describe("pullDownOnFloatingNet", () => {
    it("executePullDown writes 0 to output slot", () => {
      const layout = makeLayoutSingle(0, 0);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 0xFFFFFFFF; // pre-fill with all-ones
      executePullDown(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });

    it("executePullDown always writes 0 regardless of prior state", () => {
      const layout = makeLayoutSingle(0, 0);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      state[0] = 42;
      executePullDown(0, state, highZs, layout);
      expect(state[0]).toBe(0);
    });

    it("executePullDown can be called 1000 times without error", () => {
      const layout = makeLayoutSingle(0, 0);
      const state = makeState(2);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        executePullDown(0, state, highZs, layout);
      }
      expect(state[0]).toBe(0);
    });

    it("PullUp and PullDown write opposite values", () => {
      const layout = makeLayoutSingle(0, 0);

      const stateUp = makeState(2);
      executePullUp(0, stateUp, new Uint32Array(stateUp.length), layout);

      const stateDown = makeState(2);
      stateDown[0] = 0xFFFFFFFF;
      executePullDown(0, stateDown, new Uint32Array(stateDown.length), layout);

      expect(stateUp[0]).toBe(0xFFFFFFFF);
      expect(stateDown[0]).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawLine for GND rail", () => {
      const pd = makePullDown();
      const { ctx, calls } = makeStubCtx();
      pd.draw(ctx);
      expect(calls.filter((c) => c.method === "drawLine").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawPath for the resistor zigzag body", () => {
      const pd = makePullDown();
      const { ctx, calls } = makeStubCtx();
      pd.draw(ctx);
      expect(calls.filter((c) => c.method === "drawPath").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() with label calls drawText", () => {
      const pd = makePullDown({ label: "R2" });
      const { ctx, calls } = makeStubCtx();
      pd.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText").some((c) => c.args[0] === "R2")).toBe(true);
    });

    it("draw() without label does not call drawText", () => {
      const pd = makePullDown();
      const { ctx, calls } = makeStubCtx();
      pd.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText")).toHaveLength(0);
    });

    it("draw() saves and restores context", () => {
      const pd = makePullDown();
      const { ctx, calls } = makeStubCtx();
      pd.draw(ctx);
      expect(calls.filter((c) => c.method === "save")).toHaveLength(1);
      expect(calls.filter((c) => c.method === "restore")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Bounding box
  // -------------------------------------------------------------------------

  describe("boundingBox", () => {
    it("getBoundingBox returns non-zero dimensions", () => {
      const pd = makePullDown();
      const bb = pd.getBoundingBox();
      expect(bb.width).toBeGreaterThanOrEqual(1);
      expect(bb.height).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Attribute mapping
  // -------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Bits=4 maps to bitWidth=4", () => {
      const mapping = PULL_DOWN_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("4")).toBe(4);
    });

    it("Bits=16 maps to bitWidth=16", () => {
      const mapping = PULL_DOWN_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping!.convert("16")).toBe(16);
    });

    it("Label maps to label property", () => {
      const mapping = PULL_DOWN_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("R2")).toBe("R2");
    });
  });

  // -------------------------------------------------------------------------
  // ComponentDefinition completeness
  // -------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("PullDownDefinition has name='PullDown'", () => {
      expect(PullDownDefinition.name).toBe("PullDown");
    });

    it("PullDownDefinition has typeId=-1", () => {
      expect(PullDownDefinition.typeId).toBe(-1);
    });

    it("PullDownDefinition has a factory function", () => {
      expect(typeof PullDownDefinition.factory).toBe("function");
    });

    it("PullDownDefinition factory produces a PullDownElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 1);
      const el = PullDownDefinition.factory(props);
      expect(el.typeId).toBe("PullDown");
    });

    it("PullDownDefinition has executeFn=executePullDown", () => {
      expect(PullDownDefinition.executeFn).toBe(executePullDown);
    });

    it("PullDownDefinition category is PLD", () => {
      expect(PullDownDefinition.category).toBe(ComponentCategory.PLD);
    });

    it("PullDownDefinition has non-empty helpText", () => {
      expect(typeof PullDownDefinition.helpText).toBe("string"); expect(PullDownDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("PullDownDefinition has non-empty propertyDefs", () => {
      expect(PullDownDefinition.propertyDefs.length).toBeGreaterThan(0);
    });

    it("PullDownDefinition propertyDefs include 'bitWidth'", () => {
      const keys = PullDownDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("bitWidth");
    });

    it("PullDownDefinition can be registered without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PullDownDefinition)).not.toThrow();
    });

    it("After registration PullDown typeId is non-negative", () => {
      const registry = new ComponentRegistry();
      registry.register(PullDownDefinition);
      const registered = registry.get("PullDown");
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });

    it("PullDownDefinition defaultDelay is 0", () => {
      expect(PullDownDefinition.defaultDelay).toBe(0);
    });

    it("PullDownDefinition helpText mentions 'logic 0' or 'GND'", () => {
      const text = PullDownDefinition.helpText;
      expect(text.includes("logic 0") || text.includes("GND")).toBe(true);
    });
  });
});
