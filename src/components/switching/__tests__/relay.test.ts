/**
 * Tests for Relay and RelayDT components.
 *
 * Covers:
 *   - Coil energised state (in1 XOR in2)
 *   - Normally-open relay: energised → closed (state=1)
 *   - Normally-closed relay: energised → open (state=0 for bus resolver)
 *   - Both coil terminals same → de-energised
 *   - RelayDT: energised → state=1 (C-T), de-energised → state=0 (C-R)
 *   - Pin layout (coil inputs + bidirectional contacts)
 *   - Attribute mappings
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  RelayElement,
  executeRelay,
  RelayDefinition,
  RELAY_ATTRIBUTE_MAPPINGS,
} from "../relay.js";
import type { RelayLayout } from "../relay.js";
import {
  RelayDTElement,
  executeRelayDT,
  RelayDTDefinition,
  RELAY_DT_ATTRIBUTE_MAPPINGS,
} from "../relay-dt.js";
import type { RelayDTLayout } from "../relay-dt.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function makeRelayLayout(inputCount: number, stateCount: number): {
  layout: ComponentLayout & RelayLayout;
  state: Uint32Array;
} {
  const state = new Uint32Array(inputCount + stateCount);
  const layout: ComponentLayout & RelayLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => inputCount,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => 0,
    outputOffset: (_i: number) => inputCount,
    stateOffset: (_i: number) => inputCount,
  };
  return { layout, state };
}

function makeRelayDTLayout(inputCount: number, stateCount: number): {
  layout: ComponentLayout & RelayDTLayout;
  state: Uint32Array;
} {
  const state = new Uint32Array(inputCount + stateCount);
  const layout: ComponentLayout & RelayDTLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => inputCount,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => 0,
    outputOffset: (_i: number) => inputCount,
    stateOffset: (_i: number) => inputCount,
  };
  return { layout, state };
}

// ---------------------------------------------------------------------------
// Relay (SPST) tests
// ---------------------------------------------------------------------------

describe("Relay", () => {
  it("coilEnergised — in1=0 in2=1 → state=1 (closed)", () => {
    // 2 coil inputs + 1 state slot
    const { layout, state } = makeRelayLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; // in1
    state[1] = 1; // in2
    executeRelay(0, state, highZs, layout);
    expect(state[2]).toBe(1); // closed
  });

  it("coilEnergised — in1=1 in2=0 → state=1 (closed)", () => {
    const { layout, state } = makeRelayLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; state[1] = 0;
    executeRelay(0, state, highZs, layout);
    expect(state[2]).toBe(1);
  });

  it("coilDeenergised — in1=0 in2=0 → state=0 (open)", () => {
    const { layout, state } = makeRelayLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 0;
    executeRelay(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("coilDeenergised — in1=1 in2=1 → state=0 (open)", () => {
    const { layout, state } = makeRelayLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; state[1] = 1;
    executeRelay(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("coilTransitions — energised then de-energised", () => {
    const { layout, state } = makeRelayLayout(2, 1);
    const highZs = new Uint32Array(state.length);

    state[0] = 1; state[1] = 0;
    executeRelay(0, state, highZs, layout);
    expect(state[2]).toBe(1); // closed

    state[0] = 0; state[1] = 0;
    executeRelay(0, state, highZs, layout);
    expect(state[2]).toBe(0); // open
  });

  it("normallyClosed — reported by element correctly", () => {
    const props = new PropertyBag();
    props.set("normallyClosed", true);
    const el = new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.normallyClosed).toBe(true);
  });

  it("normallyOpenDefault — defaults to false", () => {
    const props = new PropertyBag();
    const el = new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.normallyClosed).toBe(false);
  });

  it("pinLayout — 2 coil inputs + 2 bidirectional contact pins per pole", () => {
    const props = new PropertyBag();
    props.set("poles", 1);
    const el = new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(inputs.length).toBe(2); // in1, in2
    expect(bidirectional.length).toBe(2); // A1, B1
    const labels = pins.map(p => p.label);
    expect(labels).toContain("in1");
    expect(labels).toContain("in2");
    expect(labels).toContain("A1");
    expect(labels).toContain("B1");
  });

  it("pinLayout2Poles — 2 coil inputs + 4 bidirectional pins for 2 poles", () => {
    const props = new PropertyBag();
    props.set("poles", 2);
    const el = new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(bidirectional.length).toBe(4); // A1, B1, A2, B2
  });

  it("attributeMapping — Bits, Label, Poles, normallyClosed map correctly", () => {
    const bitsMap = RELAY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const labelMap = RELAY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    const polesMap = RELAY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Poles");
    const ncMap = RELAY_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "relayNormallyClosed");

    expect(bitsMap!.convert("4")).toBe(4);
    expect(labelMap!.convert("K1")).toBe("K1");
    expect(polesMap!.convert("3")).toBe(3);
    expect(ncMap!.convert("true")).toBe(true);
    expect(ncMap!.convert("false")).toBe(false);
  });

  it("draw — renders coil rectangle and NO label", () => {
    const props = new PropertyBag();
    const el = new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const calls: string[] = [];
    const texts: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawRect: () => calls.push("drawRect"),
      drawText: (t: string) => texts.push(t),
      drawLine: () => calls.push("drawLine"),
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawRect"); // coil rectangle
    expect(texts).toContain("NO");      // normally-open label
  });

  it("drawNormallyClosed — NC label rendered", () => {
    const props = new PropertyBag();
    props.set("normallyClosed", true);
    const el = new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawRect: () => {}, drawText: (t: string) => texts.push(t), drawLine: () => {},
    };
    el.draw(ctx as never);
    expect(texts).toContain("NC");
  });

  it("definitionComplete — RelayDefinition has all required fields", () => {
    expect(RelayDefinition.name).toBe("Relay");
    expect(RelayDefinition.factory).toBeDefined();
    expect(RelayDefinition.executeFn).toBeDefined();
    expect(RelayDefinition.pinLayout).toBeDefined();
    expect(RelayDefinition.propertyDefs).toBeDefined();
    expect(RelayDefinition.attributeMap).toBeDefined();
    expect(RelayDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(RelayDefinition.helpText).toBeDefined();
    expect(typeof RelayDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns RelayElement", () => {
    const props = new PropertyBag();
    expect(RelayDefinition.factory(props)).toBeInstanceOf(RelayElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });

  it("boundingBox — returns non-zero dimensions", () => {
    const props = new PropertyBag();
    const el = new RelayElement(crypto.randomUUID(), { x: 1, y: 2 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(1);
    expect(bb.y).toBe(2);
    expect(bb.width).toBeGreaterThanOrEqual(2);
    expect(bb.height).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// RelayDT (SPDT) tests
// ---------------------------------------------------------------------------

describe("RelayDT", () => {
  it("coilEnergised — in1 XOR in2 → state=1 (C connects to T)", () => {
    const { layout, state } = makeRelayDTLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; state[1] = 0;
    executeRelayDT(0, state, highZs, layout);
    expect(state[2]).toBe(1); // energised → C-T
  });

  it("coilEnergised — in1=0 in2=1 → state=1", () => {
    const { layout, state } = makeRelayDTLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 1;
    executeRelayDT(0, state, highZs, layout);
    expect(state[2]).toBe(1);
  });

  it("coilDeenergised — in1=in2=0 → state=0 (C connects to R)", () => {
    const { layout, state } = makeRelayDTLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 0; state[1] = 0;
    executeRelayDT(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("coilDeenergised — in1=in2=1 → state=0", () => {
    const { layout, state } = makeRelayDTLayout(2, 1);
    const highZs = new Uint32Array(state.length);
    state[0] = 1; state[1] = 1;
    executeRelayDT(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("coilTransitions — energised then de-energised", () => {
    const { layout, state } = makeRelayDTLayout(2, 1);
    const highZs = new Uint32Array(state.length);

    state[0] = 1; state[1] = 0;
    executeRelayDT(0, state, highZs, layout);
    expect(state[2]).toBe(1);

    state[0] = 0;
    executeRelayDT(0, state, highZs, layout);
    expect(state[2]).toBe(0);
  });

  it("pinLayout — 2 coil inputs + 3 bidirectional pins per pole (C, T, R)", () => {
    const props = new PropertyBag();
    props.set("poles", 1);
    const el = new RelayDTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(inputs.length).toBe(2); // in1, in2
    expect(bidirectional.length).toBe(3); // C1, T1, R1
    const labels = pins.map(p => p.label);
    expect(labels).toContain("in1");
    expect(labels).toContain("in2");
    expect(labels).toContain("C1");
    expect(labels).toContain("T1");
    expect(labels).toContain("R1");
  });

  it("pinLayout2Poles — 2 coil inputs + 6 bidirectional pins for 2 poles", () => {
    const props = new PropertyBag();
    props.set("poles", 2);
    const el = new RelayDTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const bidirectional = el.getPins().filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(bidirectional.length).toBe(6); // C1, T1, R1, C2, T2, R2
  });

  it("attributeMapping — Bits, Label, Poles map correctly", () => {
    const bitsMap = RELAY_DT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const labelMap = RELAY_DT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    const polesMap = RELAY_DT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Poles");

    expect(bitsMap!.convert("8")).toBe(8);
    expect(labelMap!.convert("K2")).toBe("K2");
    expect(polesMap!.convert("2")).toBe(2);
  });

  it("draw — renders coil rectangle and DT label", () => {
    const props = new PropertyBag();
    const el = new RelayDTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);

    const calls: string[] = [];
    const texts: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawRect: () => calls.push("drawRect"),
      drawText: (t: string) => texts.push(t),
      drawLine: () => calls.push("drawLine"),
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("drawRect");
    expect(texts).toContain("DT");
  });

  it("definitionComplete — RelayDTDefinition has all required fields", () => {
    expect(RelayDTDefinition.name).toBe("RelayDT");
    expect(RelayDTDefinition.factory).toBeDefined();
    expect(RelayDTDefinition.executeFn).toBeDefined();
    expect(RelayDTDefinition.pinLayout).toBeDefined();
    expect(RelayDTDefinition.propertyDefs).toBeDefined();
    expect(RelayDTDefinition.attributeMap).toBeDefined();
    expect(RelayDTDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(RelayDTDefinition.helpText).toBeDefined();
    expect(typeof RelayDTDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns RelayDTElement", () => {
    const props = new PropertyBag();
    expect(RelayDTDefinition.factory(props)).toBeInstanceOf(RelayDTElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new RelayDTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });
});
