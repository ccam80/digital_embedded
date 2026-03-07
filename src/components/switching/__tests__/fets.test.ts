/**
 * Tests for NFET, PFET, FGNFET, FGPFET, and TransGate components.
 *
 * Covers:
 *   - Gate voltage → switch state (open/closed)
 *   - Floating gate blow permanently disables conduction
 *   - TransGate: complementary gate pair controls bidirectional switch
 *   - TransGate: S==~S (invalid) → open
 *   - Pin layout (inputs + bidirectional)
 *   - Attribute mappings
 *   - Rendering
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  NFETElement,
  executeNFET,
  NFETDefinition,
  NFET_ATTRIBUTE_MAPPINGS,
} from "../nfet.js";
import type { FETLayout } from "../nfet.js";
import {
  PFETElement,
  executePFET,
  PFETDefinition,
  PFET_ATTRIBUTE_MAPPINGS,
} from "../pfet.js";
import {
  FGNFETElement,
  executeFGNFET,
  FGNFETDefinition,
  FGNFET_ATTRIBUTE_MAPPINGS,
} from "../fgnfet.js";
import {
  FGPFETElement,
  executeFGPFET,
  FGPFETDefinition,
  FGPFET_ATTRIBUTE_MAPPINGS,
} from "../fgpfet.js";
import {
  TransGateElement,
  executeTransGate,
  TransGateDefinition,
  TRANS_GATE_ATTRIBUTE_MAPPINGS,
} from "../trans-gate.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helper
// ---------------------------------------------------------------------------

function makeFETLayout(inputCount: number, stateCount: number): {
  layout: ComponentLayout & FETLayout;
  state: Uint32Array;
  highZs: Uint32Array;
} {
  const state = new Uint32Array(inputCount + stateCount);
  const highZs = new Uint32Array(state.length);
  const layout: ComponentLayout & FETLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => inputCount,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => 0,
    outputOffset: (_i: number) => inputCount,
    stateOffset: (_i: number) => inputCount,
  };
  return { layout, state, highZs };
}

// ---------------------------------------------------------------------------
// NFET tests
// ---------------------------------------------------------------------------

describe("NFET", () => {
  it("gateHigh — G=1 → closed (state=1)", () => {
    const { layout, state, highZs } = makeFETLayout(1, 1);
    state[0] = 1; // G
    executeNFET(0, state, highZs, layout);
    expect(state[1]).toBe(1);
  });

  it("gateLow — G=0 → open (state=0)", () => {
    const { layout, state, highZs } = makeFETLayout(1, 1);
    state[0] = 0; // G
    executeNFET(0, state, highZs, layout);
    expect(state[1]).toBe(0);
  });

  it("gateTransitions — toggles correctly", () => {
    const { layout, state, highZs } = makeFETLayout(1, 1);

    state[0] = 1;
    executeNFET(0, state, highZs, layout);
    expect(state[1]).toBe(1);

    state[0] = 0;
    executeNFET(0, state, highZs, layout);
    expect(state[1]).toBe(0);

    state[0] = 1;
    executeNFET(0, state, highZs, layout);
    expect(state[1]).toBe(1);
  });

  it("pinLayout — 1 input (G) + 2 bidirectional (D, S)", () => {
    const props = new PropertyBag();
    const el = new NFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(inputs.length).toBe(1);
    expect(bidirectional.length).toBe(2);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });

  it("attributeMapping — Bits and Label map correctly", () => {
    const bitsMap = NFET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const labelMap = NFET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    expect(bitsMap!.convert("4")).toBe(4);
    expect(labelMap!.convert("Q1")).toBe("Q1");
  });

  it("draw — renders lines and gate elements", () => {
    const props = new PropertyBag();
    const el = new NFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawLine: () => calls.push("drawLine"),
      drawText: () => {},
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls.filter(c => c === "drawLine").length).toBeGreaterThan(0);
  });

  it("draw — renders label when set", () => {
    const props = new PropertyBag();
    props.set("label", "Q1");
    const el = new NFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawLine: () => {}, drawText: (t: string) => texts.push(t),
    };
    el.draw(ctx as never);
    expect(texts).toContain("Q1");
  });

  it("definitionComplete — NFETDefinition has all required fields", () => {
    expect(NFETDefinition.name).toBe("NFET");
    expect(NFETDefinition.factory).toBeDefined();
    expect(NFETDefinition.executeFn).toBeDefined();
    expect(NFETDefinition.pinLayout).toBeDefined();
    expect(NFETDefinition.propertyDefs).toBeDefined();
    expect(NFETDefinition.attributeMap).toBeDefined();
    expect(NFETDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(NFETDefinition.helpText).toBeDefined();
    expect(typeof NFETDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns NFETElement", () => {
    const props = new PropertyBag();
    expect(NFETDefinition.factory(props)).toBeInstanceOf(NFETElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new NFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });

  it("boundingBox — non-zero dimensions at correct position", () => {
    const props = new PropertyBag();
    const el = new NFETElement(crypto.randomUUID(), { x: 2, y: 3 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(2);
    expect(bb.y).toBe(3);
    expect(bb.width).toBeGreaterThanOrEqual(2);
    expect(bb.height).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// PFET tests
// ---------------------------------------------------------------------------

describe("PFET", () => {
  it("gateLow — G=0 → closed (state=1)", () => {
    const { layout, state, highZs } = makeFETLayout(1, 1);
    state[0] = 0; // G
    executePFET(0, state, highZs, layout);
    expect(state[1]).toBe(1);
  });

  it("gateHigh — G=1 → open (state=0)", () => {
    const { layout, state, highZs } = makeFETLayout(1, 1);
    state[0] = 1; // G
    executePFET(0, state, highZs, layout);
    expect(state[1]).toBe(0);
  });

  it("gateTransitions — toggles correctly (inverted vs NFET)", () => {
    const { layout, state, highZs } = makeFETLayout(1, 1);

    state[0] = 0;
    executePFET(0, state, highZs, layout);
    expect(state[1]).toBe(1); // conducting

    state[0] = 1;
    executePFET(0, state, highZs, layout);
    expect(state[1]).toBe(0); // non-conducting
  });

  it("pinLayout — 1 input (G) + 2 bidirectional (S, D)", () => {
    const props = new PropertyBag();
    const el = new PFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(inputs.length).toBe(1);
    expect(bidirectional.length).toBe(2);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("S");
    expect(labels).toContain("D");
  });

  it("attributeMapping — Bits and Label map correctly", () => {
    const bitsMap = PFET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const labelMap = PFET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    expect(bitsMap!.convert("8")).toBe(8);
    expect(labelMap!.convert("P1")).toBe("P1");
  });

  it("draw — renders gate inversion bubble (drawCircle)", () => {
    const props = new PropertyBag();
    const el = new PFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawLine: () => calls.push("drawLine"),
      drawCircle: () => calls.push("drawCircle"),
      drawText: () => {},
    };
    el.draw(ctx as never);
    expect(calls).toContain("drawCircle");
  });

  it("definitionComplete — PFETDefinition has all required fields", () => {
    expect(PFETDefinition.name).toBe("PFET");
    expect(PFETDefinition.factory).toBeDefined();
    expect(PFETDefinition.executeFn).toBeDefined();
    expect(PFETDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(typeof PFETDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns PFETElement", () => {
    const props = new PropertyBag();
    expect(PFETDefinition.factory(props)).toBeInstanceOf(PFETElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new PFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FGNFET tests
// ---------------------------------------------------------------------------

describe("FGNFET", () => {
  it("gateHigh_notBlown — G=1, blown=0 → closed (state=1)", () => {
    // State layout: [G=0, closedFlag=1, blownFlag=2]
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 1;  // G high
    state[2] = 0;  // blownFlag=0
    executeFGNFET(0, state, highZs, layout);
    expect(state[1]).toBe(1); // closedFlag=1 (conducting)
  });

  it("gateLow_notBlown — G=0, blown=0 → open (state=0)", () => {
    // State layout: inputs=[G], state=[closedFlag, blownFlag]
    // Total slots: 1 input + 2 state = 3
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 0;  // G
    state[1] = 0;  // closedFlag (will be written)
    state[2] = 0;  // blownFlag
    executeFGNFET(0, state, highZs, layout);
    expect(state[1]).toBe(0); // closed=0 (gate low)
  });

  it("gateHigh_notBlown — G=1, blown=0 → closed=1", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 1;  // G
    state[2] = 0;  // blownFlag=0
    executeFGNFET(0, state, highZs, layout);
    expect(state[1]).toBe(1); // closed=1
  });

  it("blown_gateHigh — G=1, blown=1 → permanently open (state=0)", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 1;  // G high
    state[2] = 1;  // blownFlag=1
    executeFGNFET(0, state, highZs, layout);
    expect(state[1]).toBe(0); // blown → always open
  });

  it("blown_gateLow — G=0, blown=1 → still open", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 0;  // G low
    state[2] = 1;  // blownFlag=1
    executeFGNFET(0, state, highZs, layout);
    expect(state[1]).toBe(0); // blown → always open
  });

  it("blownProperty — element exposes blown flag", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(true);
  });

  it("notBlownDefault — defaults to false", () => {
    const props = new PropertyBag();
    const el = new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(false);
  });

  it("draw — renders blown X mark when blown", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const colors: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: (c: string) => colors.push(c),
      setLineWidth: () => {}, setFont: () => {},
      drawLine: () => {}, drawText: () => {}, drawCircle: () => {},
    };
    el.draw(ctx as never);
    expect(colors).toContain("ERROR");
  });

  it("draw_notBlown — no ERROR color when not blown", () => {
    const props = new PropertyBag();
    const el = new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const colors: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: (c: string) => colors.push(c),
      setLineWidth: () => {}, setFont: () => {},
      drawLine: () => {}, drawText: () => {}, drawCircle: () => {},
    };
    el.draw(ctx as never);
    expect(colors).not.toContain("ERROR");
  });

  it("attributeMapping — Bits, Label, blown map correctly", () => {
    const bitsMap = FGNFET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const blownMap = FGNFET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "blown");
    expect(bitsMap!.convert("4")).toBe(4);
    expect(blownMap!.convert("true")).toBe(true);
    expect(blownMap!.convert("false")).toBe(false);
  });

  it("definitionComplete — FGNFETDefinition has all required fields", () => {
    expect(FGNFETDefinition.name).toBe("FGNFET");
    expect(FGNFETDefinition.factory).toBeDefined();
    expect(FGNFETDefinition.executeFn).toBeDefined();
    expect(FGNFETDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(typeof FGNFETDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns FGNFETElement", () => {
    const props = new PropertyBag();
    expect(FGNFETDefinition.factory(props)).toBeInstanceOf(FGNFETElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FGPFET tests
// ---------------------------------------------------------------------------

describe("FGPFET", () => {
  it("gateLow_notBlown — G=0, blown=0 → closed=1 (P-channel)", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 0;  // G low
    state[2] = 0;  // blownFlag=0
    executeFGPFET(0, state, highZs, layout);
    expect(state[1]).toBe(1); // closed (PFET: gate low → conducting)
  });

  it("gateHigh_notBlown — G=1, blown=0 → open=0", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 1;  // G high
    state[2] = 0;  // blownFlag=0
    executeFGPFET(0, state, highZs, layout);
    expect(state[1]).toBe(0); // open (PFET: gate high → non-conducting)
  });

  it("blown_gateLow — G=0, blown=1 → permanently open", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 0;  // G low (would normally close)
    state[2] = 1;  // blownFlag=1
    executeFGPFET(0, state, highZs, layout);
    expect(state[1]).toBe(0); // blown → always open
  });

  it("blown_gateHigh — G=1, blown=1 → still open", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 1,
      stateOffset: () => 1,
    };
    state[0] = 1;  // G high
    state[2] = 1;  // blownFlag=1
    executeFGPFET(0, state, highZs, layout);
    expect(state[1]).toBe(0); // blown → always open
  });

  it("blownProperty — element exposes blown flag", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FGPFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(true);
  });

  it("draw — renders blown indicator when blown", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FGPFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const colors: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: (c: string) => colors.push(c),
      setLineWidth: () => {}, setFont: () => {},
      drawLine: () => {}, drawText: () => {}, drawCircle: () => {},
    };
    el.draw(ctx as never);
    expect(colors).toContain("ERROR");
  });

  it("attributeMapping — blown converts string to boolean", () => {
    const blownMap = FGPFET_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "blown");
    expect(blownMap!.convert("true")).toBe(true);
    expect(blownMap!.convert("false")).toBe(false);
  });

  it("definitionComplete — FGPFETDefinition has all required fields", () => {
    expect(FGPFETDefinition.name).toBe("FGPFET");
    expect(FGPFETDefinition.factory).toBeDefined();
    expect(FGPFETDefinition.executeFn).toBeDefined();
    expect(FGPFETDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(typeof FGPFETDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns FGPFETElement", () => {
    const props = new PropertyBag();
    expect(FGPFETDefinition.factory(props)).toBeInstanceOf(FGPFETElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new FGPFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TransGate tests
// ---------------------------------------------------------------------------

describe("TransGate", () => {
  it("S=1 ~S=0 — valid complementary pair, gate on → closed (state=1)", () => {
    const state = new Uint32Array(3); // [S=0, ~S=1, closedFlag=2]
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 2,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 2,
      stateOffset: () => 2,
    };
    state[0] = 1;  // S
    state[1] = 0;  // ~S
    executeTransGate(0, state, highZs, layout);
    expect(state[2]).toBe(1); // closed
  });

  it("S=0 ~S=1 — valid complementary pair, gate off → open (state=0)", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 2,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 2,
      stateOffset: () => 2,
    };
    state[0] = 0;  // S
    state[1] = 1;  // ~S
    executeTransGate(0, state, highZs, layout);
    expect(state[2]).toBe(0); // open
  });

  it("S=0 ~S=0 — invalid (same) → open (state=0)", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 2,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 2,
      stateOffset: () => 2,
    };
    state[0] = 0;  // S
    state[1] = 0;  // ~S
    executeTransGate(0, state, highZs, layout);
    expect(state[2]).toBe(0); // invalid → open
  });

  it("S=1 ~S=1 — invalid (same) → open (state=0)", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 2,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 2,
      stateOffset: () => 2,
    };
    state[0] = 1;  // S
    state[1] = 1;  // ~S
    executeTransGate(0, state, highZs, layout);
    expect(state[2]).toBe(0); // invalid → open
  });

  it("gateTransitions — toggling S and ~S changes state", () => {
    const state = new Uint32Array(3);
    const highZs = new Uint32Array(state.length);
    const layout: ComponentLayout & FETLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 2,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 2,
      stateOffset: () => 2,
    };

    state[0] = 1; state[1] = 0;
    executeTransGate(0, state, highZs, layout);
    expect(state[2]).toBe(1); // closed

    state[0] = 0; state[1] = 1;
    executeTransGate(0, state, highZs, layout);
    expect(state[2]).toBe(0); // open
  });

  it("pinLayout — 2 inputs (S, ~S) + 2 bidirectional (A, B)", () => {
    const props = new PropertyBag();
    const el = new TransGateElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(inputs.length).toBe(2);
    expect(bidirectional.length).toBe(2);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("S");
    expect(labels).toContain("~S");
    expect(labels).toContain("A");
    expect(labels).toContain("B");
  });

  it("attributeMapping — Bits and Label map correctly", () => {
    const bitsMap = TRANS_GATE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    const labelMap = TRANS_GATE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    expect(bitsMap!.convert("16")).toBe(16);
    expect(labelMap!.convert("TG1")).toBe("TG1");
  });

  it("draw — renders gate lines and inversion bubble", () => {
    const props = new PropertyBag();
    const el = new TransGateElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: () => {},
      setLineWidth: () => {},
      setFont: () => {},
      drawLine: () => calls.push("drawLine"),
      drawCircle: () => calls.push("drawCircle"),
      drawText: () => {},
    };
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawCircle"); // ~S inversion bubble
    expect(calls.filter(c => c === "drawLine").length).toBeGreaterThan(0);
  });

  it("draw — renders label when set", () => {
    const props = new PropertyBag();
    props.set("label", "TG1");
    const el = new TransGateElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const texts: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, translate: () => {},
      setColor: () => {}, setLineWidth: () => {}, setFont: () => {},
      drawLine: () => {}, drawCircle: () => {}, drawText: (t: string) => texts.push(t),
    };
    el.draw(ctx as never);
    expect(texts).toContain("TG1");
  });

  it("definitionComplete — TransGateDefinition has all required fields", () => {
    expect(TransGateDefinition.name).toBe("TransGate");
    expect(TransGateDefinition.factory).toBeDefined();
    expect(TransGateDefinition.executeFn).toBeDefined();
    expect(TransGateDefinition.pinLayout).toBeDefined();
    expect(TransGateDefinition.propertyDefs).toBeDefined();
    expect(TransGateDefinition.attributeMap).toBeDefined();
    expect(TransGateDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(TransGateDefinition.helpText).toBeDefined();
    expect(typeof TransGateDefinition.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns TransGateElement", () => {
    const props = new PropertyBag();
    expect(TransGateDefinition.factory(props)).toBeInstanceOf(TransGateElement);
  });

  it("helpText — returns non-empty string", () => {
    const props = new PropertyBag();
    const el = new TransGateElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.getHelpText().length).toBeGreaterThan(0);
  });

  it("boundingBox — non-zero dimensions at correct position", () => {
    const props = new PropertyBag();
    const el = new TransGateElement(crypto.randomUUID(), { x: 5, y: 7 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(5);
    expect(bb.y).toBe(7);
    expect(bb.width).toBeGreaterThanOrEqual(2);
    expect(bb.height).toBeGreaterThanOrEqual(2);
  });
});
