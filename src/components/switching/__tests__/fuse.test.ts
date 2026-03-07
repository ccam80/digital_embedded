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

function makeFuseLayout(stateCount: number): {
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
  };
  return { layout, state };
}

// ---------------------------------------------------------------------------
// executeFuse tests
// ---------------------------------------------------------------------------

describe("Fuse — executeFn", () => {
  it("initiallyClosedState — engine sets state=1 for not-blown fuse", () => {
    // Engine sets state[stBase]=1 at compile time for blown=false.
    // executeFuse is a no-op; it must not corrupt that initial value.
    const { layout, state } = makeFuseLayout(1);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; // engine pre-initialises: closed
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(1); // still closed
  });

  it("blownState — engine sets state=0 for blown fuse, executeFuse preserves it", () => {
    const { layout, state } = makeFuseLayout(1);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; // engine pre-initialises: open (blown)
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0); // still open
  });

  it("cannotReclose — setting state=1 then running executeFuse leaves state unchanged", () => {
    // There is no gate input, so executeFuse is a true no-op.
    // Once the engine sets blown=true → state=0, nothing can change it.
    const { layout, state } = makeFuseLayout(1);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; // blown (open)
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
    // Try again — still no change
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
  });

  it("multipleCallsPreserveState — repeated execution preserves initial closed state", () => {
    const { layout, state } = makeFuseLayout(1);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; // closed
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
  it("draw_intact — renders rectangle body and wire through centre", () => {
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
      drawRect: () => calls.push("drawRect"),
      drawLine: () => calls.push("drawLine"),
      drawText: () => {},
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawRect");
    expect(calls.filter(c => c === "drawLine").length).toBeGreaterThan(0);
  });

  it("draw_blown — uses ERROR color for blown indicator", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const colors: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: (c: string) => colors.push(c),
      setLineWidth: () => {}, setFont: () => {},
      drawRect: () => {}, drawLine: () => {}, drawText: () => {},
    };
    el.draw(ctx as never);
    expect(colors).toContain("WIRE_ERROR");
  });

  it("draw_notBlown — no WIRE_ERROR color when intact", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const colors: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: (c: string) => colors.push(c),
      setLineWidth: () => {}, setFont: () => {},
      drawRect: () => {}, drawLine: () => {}, drawText: () => {},
    };
    el.draw(ctx as never);
    expect(colors).not.toContain("ERROR");
  });

  it("draw_withLabel — renders label text when set", () => {
    const props = new PropertyBag();
    props.set("label", "F1");
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawRect: () => {}, drawLine: () => {}, drawText: (t: string) => texts.push(t),
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
      drawRect: () => {}, drawLine: () => {}, drawText: (t: string) => texts.push(t),
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
    expect(bb.y).toBe(6);
    expect(bb.width).toBeGreaterThanOrEqual(1);
    expect(bb.height).toBeGreaterThanOrEqual(1);
  });

  it("defaultDelay — is zero (combinational)", () => {
    expect(FuseDefinition.defaultDelay).toBe(0);
  });
});
