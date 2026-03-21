/**
 * Tests for Fuse component.
 *
 * Covers:
 *   - Initially closed (blown=false → state=1)
 *   - Blown → permanently open (state=0)
 *   - Cannot re-close once blown (no gate input)
 *   - Pin layout (2 bidirectional, no inputs)
 *   - Attribute mappings
 *   - Rendering (intact wire vs blown X mark)
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  FuseElement,
  executeFuse,
  FuseDefinition,
  FUSE_ATTRIBUTE_MAPPINGS,
} from "../fuse.js";
import type { FETLayout } from "../nfet.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helper
// ---------------------------------------------------------------------------

function makeFuseLayout(stateCount: number, blown: boolean = false): {
  layout: ComponentLayout & FETLayout;
  state: Uint32Array;
} {
  // Fuse has no inputs; state slots start at 0
  const state = new Uint32Array(stateCount);
  const layout: ComponentLayout & FETLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => 0,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => 0,
    outputOffset: (_i: number) => 0,
    stateOffset: (_i: number) => 0,
    getProperty: (_i: number, key: string) => (key === "blown" ? blown : undefined),
  };
  return { layout, state };
}

// ---------------------------------------------------------------------------
// executeFuse tests
// ---------------------------------------------------------------------------

describe("Fuse — executeFn", () => {
  it("initiallyClosedState — blown=false writes state=1 (closed)", () => {
    const { layout, state } = makeFuseLayout(1, false);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(1); // closed
  });

  it("blownState — blown=true writes state=0 (open)", () => {
    const { layout, state } = makeFuseLayout(1, true);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0); // open
  });

  it("cannotReclose — blown fuse stays open across multiple executions", () => {
    const { layout, state } = makeFuseLayout(1, true);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
  });

  it("multipleCallsPreserveState — repeated execution preserves closed state", () => {
    const { layout, state } = makeFuseLayout(1, false);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FuseElement property tests
// ---------------------------------------------------------------------------

describe("Fuse — element properties", () => {
  it("blownFalse — defaults to not blown", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(false);
  });

  it("blownTrue — blown property reflects true when set", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pin layout tests
// ---------------------------------------------------------------------------

describe("Fuse — pin layout", () => {
  it("pinLayout — no inputs, 2 bidirectional (out1, out2)", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(inputs.length).toBe(0);
    expect(bidirectional.length).toBe(2);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("out1");
    expect(labels).toContain("out2");
  });
});

// ---------------------------------------------------------------------------
// Attribute mapping tests
// ---------------------------------------------------------------------------

describe("Fuse — attribute mappings", () => {
  it("bitsMapping — Bits attribute converts to number", () => {
    const bitsMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    expect(bitsMap!.convert("8")).toBe(8);
    expect(bitsMap!.convert("1")).toBe(1);
  });

  it("labelMapping — Label attribute passes through as string", () => {
    const labelMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    expect(labelMap!.convert("F1")).toBe("F1");
  });

  it("blownMapping — blown attribute converts string to boolean", () => {
    const blownMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "blown");
    expect(blownMap!.convert("true")).toBe(true);
    expect(blownMap!.convert("false")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe("Fuse — rendering", () => {
  it("draw_intact — renders bezier wavy path (drawPath)", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawPath: () => calls.push("drawPath"),
      drawText: () => {},
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    // Fuse draws a wavy S-curve using drawPath (bezier), not drawRect/drawLine
    expect(calls).toContain("drawPath");
  });

  it("draw_blown — blown fuse draws same wavy path (no special blown color)", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawPath: () => calls.push("drawPath"),
      drawText: () => {},
    };
    el.draw(ctx as never);
    // blown state is reflected in simulation state, not via a different draw color
    expect(calls).toContain("drawPath");
  });

  it("draw_notBlown — no WIRE_ERROR color when intact", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const colors: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: (c: string) => colors.push(c),
      setLineWidth: () => {}, setFont: () => {},
      drawPath: () => {}, drawText: () => {},
    };
    el.draw(ctx as never);
    expect(colors).not.toContain("WIRE_ERROR");
  });

  it("draw_withLabel — renders label text when set", () => {
    const props = new PropertyBag();
    props.set("label", "F1");
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawPath: () => {}, drawText: (t: string) => texts.push(t),
    };
    el.draw(ctx as never);
    expect(texts).toContain("F1");
  });

  it("draw_noLabel — no text rendered when label is empty", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawPath: () => {}, drawText: (t: string) => texts.push(t),
    };
    el.draw(ctx as never);
    expect(texts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition tests
// ---------------------------------------------------------------------------

describe("Fuse — ComponentDefinition", () => {
  it("definitionComplete — FuseDefinition has all required fields", () => {
    expect(FuseDefinition.name).toBe("Fuse");
    expect(FuseDefinition.factory).toBeDefined();
    expect(FuseDefinition.executeFn).toBeDefined();
    expect(FuseDefinition.pinLayout).toBeDefined();
    expect(FuseDefinition.propertyDefs).toBeDefined();
    expect(FuseDefinition.attributeMap).toBeDefined();
    expect(FuseDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(FuseDefinition.helpText).toBeDefined();
    expect(typeof FuseDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns FuseElement", () => {
    const props = new PropertyBag();
    expect(FuseDefinition.factory(props)).toBeInstanceOf(FuseElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });

  it("boundingBox — non-zero dimensions at correct position", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 4, y: 6 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(4);
    // getBoundingBox offsets y by -0.25 (wavy path extends above pin centre)
    expect(bb.y).toBeCloseTo(5.75);
    expect(bb.width).toBeGreaterThanOrEqual(1);
    expect(bb.height).toBeGreaterThanOrEqual(0.4);
  });

  it("defaultDelay — is zero (combinational)", () => {
    expect(FuseDefinition.defaultDelay).toBe(0);
  });
});
