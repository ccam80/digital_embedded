/**
 * Tests for wiring components: Driver, DriverInvSel, Splitter, BusSplitter, Tunnel.
 *
 * Covers:
 *   - Driver::enableHigh — enable=1, input=0xFF → output=0xFF, highZ=0
 *   - Driver::enableLow — enable=0 → output=highZ
 *   - DriverInvSel::enableLow — sel=0 (active-low enable), output=input
 *   - DriverInvSel::enableHigh — sel=1, output=highZ
 *   - Splitter::split bit extraction utilities
 *   - Splitter::merge bit insertion utilities
 *   - Splitter::splitPattern "1,1,1,1,4" on 8-bit
 *   - Tunnel::noOpExecute — executeFn does nothing
 *   - Tunnel::sameNameConnection — two Tunnels with same label declare same netName
 */

import { describe, it, expect } from "vitest";
import {
  DriverElement,
  executeDriver,
  DriverDefinition,
  DRIVER_ATTRIBUTE_MAPPINGS,
} from "../driver.js";
import {
  DriverInvSelElement,
  executeDriverInvSel,
  DriverInvSelDefinition,
} from "../driver-inv.js";
import {
  SplitterElement,
  executeSplitter,
  executeSplitterWithWidths,
  executeSplitterMergeWithWidths,
  SplitterDefinition,
  SPLITTER_ATTRIBUTE_MAPPINGS,
  parseSplittingPattern,
  totalBitsFromPattern,
  extractBits,
  insertBits,
} from "../splitter.js";
import {
  BusSplitterElement,
  executeBusSplitter,
  BusSplitterDefinition,
  BUS_SPLITTER_ATTRIBUTE_MAPPINGS,
} from "../bus-splitter.js";
import {
  TunnelElement,
  executeTunnel,
  TunnelDefinition,
  TUNNEL_ATTRIBUTE_MAPPINGS,
} from "../tunnel.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type {
  RenderContext,
  Point,
  TextAnchor,
  FontSpec,
  PathData,
  ThemeColor,
} from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mocks
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount = 1): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
  };
}

/** Layout where inputs and outputs don't overlap — for driver 2-output layout */
function makeDriverLayout(): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 2,        // data + sel
    inputOffset: () => 0,
    outputCount: () => 2,       // value + highZ
    outputOffset: () => 2,
    stateOffset: () => 4,
  };
}

function makeState(...values: number[]): Uint32Array {
  const arr = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    arr[i] = values[i] >>> 0;
  }
  return arr;
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
// Element factories
// ---------------------------------------------------------------------------

function makeDriver(bitWidth = 1): DriverElement {
  const props = new PropertyBag();
  props.set("bitWidth", bitWidth);
  return new DriverElement("test-drv-001", { x: 0, y: 0 }, 0, false, props);
}

function makeDriverInv(bitWidth = 1): DriverInvSelElement {
  const props = new PropertyBag();
  props.set("bitWidth", bitWidth);
  return new DriverInvSelElement("test-drvi-001", { x: 0, y: 0 }, 0, false, props);
}

function makeSplitter(outputSplitting = "4,4"): SplitterElement {
  const props = new PropertyBag();
  props.set("output splitting", outputSplitting);
  props.set("input splitting", "");
  return new SplitterElement("test-spl-001", { x: 0, y: 0 }, 0, false, props);
}

function makeBusSplitter(bits = 8, spreading = 1): BusSplitterElement {
  const props = new PropertyBag();
  props.set("bits", bits);
  props.set("spreading", spreading);
  return new BusSplitterElement("test-bspl-001", { x: 0, y: 0 }, 0, false, props);
}

function makeTunnel(netName: string, bitWidth = 1): TunnelElement {
  const props = new PropertyBag();
  props.set("NetName", netName);
  props.set("bitWidth", bitWidth);
  return new TunnelElement("test-tun-001", { x: 0, y: 0 }, 0, false, props);
}

// ===========================================================================
// Driver
// ===========================================================================

describe("Driver", () => {
  describe("enableHigh", () => {
    it("sel=1, input=0xFF → output=0xFF, highZ=0", () => {
      const layout = makeDriverLayout();
      // state: [data=0xFF, sel=1, outValue=0, outHighZ=0]
      const state = makeState(0xFF, 1, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeDriver(0, state, highZs, layout);
      expect(state[2]).toBe(0xFF);
      expect(state[3]).toBe(0);
    });

    it("sel=1, input=0xABCD → output=0xABCD, highZ=0", () => {
      const layout = makeDriverLayout();
      const state = makeState(0xABCD, 1, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeDriver(0, state, highZs, layout);
      expect(state[2]).toBe(0xABCD);
      expect(state[3]).toBe(0);
    });

    it("sel=1, input=0 → output=0, highZ=0 (driven low)", () => {
      const layout = makeDriverLayout();
      const state = makeState(0, 1, 0xFFFFFFFF, 0xFFFFFFFF);
      const highZs = new Uint32Array(state.length);
      executeDriver(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0);
    });
  });

  describe("enableLow", () => {
    it("sel=0, any input → output=0 (high-Z), highZ=0xFFFFFFFF", () => {
      const layout = makeDriverLayout();
      const state = makeState(0xFF, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeDriver(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0xFFFFFFFF);
    });

    it("sel=0 with large input → highZ is set regardless of input", () => {
      const layout = makeDriverLayout();
      const state = makeState(0xDEADBEEF, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeDriver(0, state, highZs, layout);
      expect(state[3]).toBe(0xFFFFFFFF);
    });
  });

  describe("draw", () => {
    it("draw calls drawPolygon for triangle body", () => {
      const el = makeDriver();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polyCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polyCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("pins", () => {
    it("Driver has 2 input pins and 1 output pin", () => {
      const el = makeDriver();
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(1);
    });

    it("Driver input pins are labeled 'in' and 'sel'", () => {
      const el = makeDriver();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("in");
      expect(labels).toContain("sel");
    });
  });

  describe("attributeMapping", () => {
    it("Bits maps to bitWidth", () => {
      const m = DRIVER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.convert("8")).toBe(8);
    });
  });

  describe("definitionComplete", () => {
    it("DriverDefinition name is 'Driver'", () => {
      expect(DriverDefinition.name).toBe("Driver");
    });

    it("DriverDefinition executeFn is executeDriver", () => {
      expect(DriverDefinition.executeFn).toBe(executeDriver);
    });

    it("DriverDefinition category is WIRING", () => {
      expect(DriverDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("DriverDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DriverDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// DriverInvSel
// ===========================================================================

describe("DriverInvSel", () => {
  describe("enableLow (active-low: sel=0 → output = input)", () => {
    it("sel=0, input=0xFF → output=0xFF, highZ=0", () => {
      const layout = makeDriverLayout();
      const state = makeState(0xFF, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeDriverInvSel(0, state, highZs, layout);
      expect(state[2]).toBe(0xFF);
      expect(state[3]).toBe(0);
    });
  });

  describe("enableHigh (sel=1 → high-Z)", () => {
    it("sel=1 → output=0, highZ=0xFFFFFFFF", () => {
      const layout = makeDriverLayout();
      const state = makeState(0xFF, 1, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeDriverInvSel(0, state, highZs, layout);
      expect(state[2]).toBe(0);
      expect(state[3]).toBe(0xFFFFFFFF);
    });
  });

  describe("draw", () => {
    it("draw renders triangle body and inversion bubble", () => {
      const el = makeDriverInv();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polyCalls = calls.filter((c) => c.method === "drawPolygon");
      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(polyCalls.length).toBeGreaterThanOrEqual(1);
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("definitionComplete", () => {
    it("DriverInvSelDefinition name is 'DriverInvSel'", () => {
      expect(DriverInvSelDefinition.name).toBe("DriverInvSel");
    });

    it("DriverInvSelDefinition executeFn is executeDriverInvSel", () => {
      expect(DriverInvSelDefinition.executeFn).toBe(executeDriverInvSel);
    });

    it("DriverInvSelDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(DriverInvSelDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// Splitter utilities
// ===========================================================================

describe("SplitterUtilities", () => {
  describe("parseSplittingPattern", () => {
    it("'4,4' → [4, 4]", () => {
      expect(parseSplittingPattern("4,4")).toEqual([4, 4]);
    });

    it("'1,1,1,1,4' → [1, 1, 1, 1, 4]", () => {
      expect(parseSplittingPattern("1,1,1,1,4")).toEqual([1, 1, 1, 1, 4]);
    });

    it("'8' → [8]", () => {
      expect(parseSplittingPattern("8")).toEqual([8]);
    });

    it("empty string → [1]", () => {
      expect(parseSplittingPattern("")).toEqual([1]);
    });
  });

  describe("totalBitsFromPattern", () => {
    it("[4, 4] → 8", () => {
      expect(totalBitsFromPattern([4, 4])).toBe(8);
    });

    it("[1, 1, 1, 1, 4] → 8", () => {
      expect(totalBitsFromPattern([1, 1, 1, 1, 4])).toBe(8);
    });

    it("[8] → 8", () => {
      expect(totalBitsFromPattern([8])).toBe(8);
    });
  });

  describe("extractBits", () => {
    it("extract bits [0,4) from 0xAB → 0xB (low nibble)", () => {
      expect(extractBits(0xAB, 0, 4)).toBe(0xB);
    });

    it("extract bits [4,8) from 0xAB → 0xA (high nibble)", () => {
      expect(extractBits(0xAB, 4, 4)).toBe(0xA);
    });

    it("extract bit 0 from 0b101 → 1", () => {
      expect(extractBits(0b101, 0, 1)).toBe(1);
    });

    it("extract bit 1 from 0b101 → 0", () => {
      expect(extractBits(0b101, 1, 1)).toBe(0);
    });

    it("extract bit 2 from 0b101 → 1", () => {
      expect(extractBits(0b101, 2, 1)).toBe(1);
    });

    it("extract all 32 bits → original value", () => {
      expect(extractBits(0xDEADBEEF, 0, 32)).toBe(0xDEADBEEF >>> 0);
    });
  });

  describe("insertBits", () => {
    it("insert 0xA into [4,8) of 0x0B → 0xAB", () => {
      expect(insertBits(0x0B, 0xA, 4, 4)).toBe(0xAB);
    });

    it("insert 0xB into [0,4) of 0xA0 → 0xAB", () => {
      expect(insertBits(0xA0, 0xB, 0, 4)).toBe(0xAB);
    });

    it("insert 1 into bit 0 of 0 → 1", () => {
      expect(insertBits(0, 1, 0, 1)).toBe(1);
    });
  });
});

// ===========================================================================
// Splitter component
// ===========================================================================

describe("Splitter", () => {
  describe("split8to4and4", () => {
    it("executeSplitterWithWidths: 0xAB → [0xB, 0xA]", () => {
      // input 0 = wide bus; outputs 0..1 = narrow ports
      const layout = makeLayout(1, 2);
      // state: [wideInput=0xAB, out0=0, out1=0]
      const state = makeState(0xAB, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeSplitterWithWidths(0, state, highZs, layout, [4, 4]);
      expect(state[1]).toBe(0xB);  // low nibble
      expect(state[2]).toBe(0xA);  // high nibble
    });
  });

  describe("merge4and4to8", () => {
    it("executeSplitterMergeWithWidths: [0xA, 0xB] → 0xBA", () => {
      // inputs 0..1 = narrow ports; output 0 = wide bus
      const layout = makeLayout(2, 1);
      // state: [in0=0xA, in1=0xB, wideOut=0]
      const state = makeState(0xA, 0xB, 0);
      const highZs = new Uint32Array(state.length);
      executeSplitterMergeWithWidths(0, state, highZs, layout, [4, 4]);
      // 0xA in [0,4) + 0xB in [4,8) = 0xBA
      expect(state[2]).toBe(0xBA);
    });
  });

  describe("splitPattern", () => {
    it("'1,1,1,1,4' on 0xF5: bits 0..3 = individual, bits 4..7 = nibble", () => {
      // 0xF5 = 0b11110101
      // bit 0 = 1, bit 1 = 0, bit 2 = 1, bit 3 = 0, bits 4..7 = 0xF
      const layout = makeLayout(1, 5);
      const state = makeState(0xF5, 0, 0, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeSplitterWithWidths(0, state, highZs, layout, [1, 1, 1, 1, 4]);
      expect(state[1]).toBe(1);   // bit 0
      expect(state[2]).toBe(0);   // bit 1
      expect(state[3]).toBe(1);   // bit 2
      expect(state[4]).toBe(0);   // bit 3
      expect(state[5]).toBe(0xF); // bits 4..7
    });
  });

  describe("draw", () => {
    it("draw calls drawLine for spine and branch lines", () => {
      const el = makeSplitter("4,4");
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("pins", () => {
    it("Splitter '4,4' has 1 input and 2 output pins", () => {
      const el = makeSplitter("4,4");
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(2);
    });

    it("Splitter '1,1,1,1,4' has 1 input and 5 output pins", () => {
      const el = makeSplitter("1,1,1,1,4");
      const pins = el.getPins();
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(5);
    });

    it("Splitter parts property reflects pattern", () => {
      const el = makeSplitter("4,4");
      expect(el.parts).toEqual([4, 4]);
    });

    it("Splitter totalBits property is correct", () => {
      const el = makeSplitter("4,4");
      expect(el.totalBits).toBe(8);
    });
  });

  describe("attributeMapping", () => {
    it("'Output Splitting' maps to 'output splitting'", () => {
      const m = SPLITTER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Output Splitting");
      expect(m).toBeDefined();
      expect(m!.convert("4,4")).toBe("4,4");
    });

    it("'Input Splitting' maps to 'input splitting'", () => {
      const m = SPLITTER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Input Splitting");
      expect(m).toBeDefined();
      expect(m!.convert("8")).toBe("8");
    });
  });

  describe("definitionComplete", () => {
    it("SplitterDefinition name is 'Splitter'", () => {
      expect(SplitterDefinition.name).toBe("Splitter");
    });

    it("SplitterDefinition executeFn is executeSplitter", () => {
      expect(SplitterDefinition.executeFn).toBe(executeSplitter);
    });

    it("SplitterDefinition category is WIRING", () => {
      expect(SplitterDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("SplitterDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(SplitterDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// BusSplitter
// ===========================================================================

describe("BusSplitter", () => {
  describe("pins", () => {
    it("default 8-bit BusSplitter has 1 input (OE) and 9 outputs (D + D0..D7)", () => {
      const el = makeBusSplitter(8);
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].label).toBe("OE");
      expect(inputs[0].bitWidth).toBe(1);
      expect(outputs).toHaveLength(9);
      expect(outputs[0].label).toBe("D");
      expect(outputs[0].bitWidth).toBe(8);
      for (let i = 1; i < 9; i++) {
        expect(outputs[i].label).toBe(`D${i - 1}`);
        expect(outputs[i].bitWidth).toBe(1);
      }
    });

    it("4-bit BusSplitter has 1 input and 5 outputs", () => {
      const el = makeBusSplitter(4);
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(5);
    });

    it("bits and spreading properties are accessible", () => {
      const el = makeBusSplitter(4, 2);
      expect(el.bits).toBe(4);
      expect(el.spreading).toBe(2);
    });
  });

  describe("boundingBox", () => {
    it("8-bit default: width=1, height=8", () => {
      const el = makeBusSplitter(8);
      const bb = el.getBoundingBox();
      expect(bb.width).toBe(1);
      expect(bb.height).toBe(8);
    });

    it("2-bit: width=1, height=2", () => {
      const el = makeBusSplitter(2);
      const bb = el.getBoundingBox();
      expect(bb.width).toBe(1);
      expect(bb.height).toBe(2);
    });

    it("1-bit: width=1, height=2 (minimum)", () => {
      const el = makeBusSplitter(1);
      const bb = el.getBoundingBox();
      expect(bb.width).toBe(1);
      expect(bb.height).toBe(2);
    });

    it("4-bit spreading=2: height = (4-1)*2+1 = 7", () => {
      const el = makeBusSplitter(4, 2);
      const bb = el.getBoundingBox();
      expect(bb.height).toBe(7);
    });
  });

  describe("draw", () => {
    it("draw renders D/OE lead lines on left and bit lead lines on right", () => {
      const el = makeBusSplitter(4);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      // D lead (0→0.5), OE lead (0→0.5), and 4 bit leads (1→0.5 each) = 6 lines
      expect(lineCalls).toHaveLength(6);
    });

    it("draw renders D, OE and bit labels", () => {
      const el = makeBusSplitter(4);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      const texts = textCalls.map((c) => c.args[0] as string);
      expect(texts).toContain("D");
      expect(texts).toContain("OE");
      expect(texts).toContain("D0");
    });
  });

  describe("execute", () => {
    it("OE=1: splits D value into individual bits", () => {
      // Layout: 1 input (OE), 9 outputs (D + D0..D7)
      const layout = makeLayout(1, 9);
      // state: [OE=1, D=0b10110011, D0..D7=0...]
      const state = makeState(1, 0b10110011, 0, 0, 0, 0, 0, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeBusSplitter(0, state, highZs, layout);
      // D0 = bit 0 = 1
      expect(state[2]).toBe(1);
      // D1 = bit 1 = 1
      expect(state[3]).toBe(1);
      // D2 = bit 2 = 0
      expect(state[4]).toBe(0);
      // D3 = bit 3 = 0
      expect(state[5]).toBe(0);
      // D4 = bit 4 = 1
      expect(state[6]).toBe(1);
      // D5 = bit 5 = 1
      expect(state[7]).toBe(1);
      // D6 = bit 6 = 0
      expect(state[8]).toBe(0);
      // D7 = bit 7 = 1
      expect(state[9]).toBe(1);
    });

    it("OE=0: all individual outputs are 0", () => {
      const layout = makeLayout(1, 9);
      const state = makeState(0, 0xFF, 1, 1, 1, 1, 1, 1, 1, 1);
      const highZs = new Uint32Array(state.length);
      executeBusSplitter(0, state, highZs, layout);
      for (let i = 2; i <= 9; i++) {
        expect(state[i]).toBe(0);
      }
    });
  });

  describe("attributeMapping", () => {
    it("Bits maps to bits with integer conversion", () => {
      const m = BUS_SPLITTER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("bits");
      expect(m!.convert("8")).toBe(8);
    });

    it("spreading maps to spreading with integer conversion", () => {
      const m = BUS_SPLITTER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "spreading");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("spreading");
      expect(m!.convert("2")).toBe(2);
    });
  });

  describe("definitionComplete", () => {
    it("BusSplitterDefinition name is 'BusSplitter'", () => {
      expect(BusSplitterDefinition.name).toBe("BusSplitter");
    });

    it("BusSplitterDefinition executeFn is executeBusSplitter", () => {
      expect(BusSplitterDefinition.executeFn).toBe(executeBusSplitter);
    });

    it("BusSplitterDefinition category is WIRING", () => {
      expect(BusSplitterDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("BusSplitterDefinition pinLayout has 3 pins for default 1-bit (D, OE, D0)", () => {
      expect(BusSplitterDefinition.pinLayout).toHaveLength(3);
    });

    it("BusSplitterDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(BusSplitterDefinition)).not.toThrow();
    });
  });
});

// ===========================================================================
// Tunnel
// ===========================================================================

describe("Tunnel", () => {
  describe("noOpExecute", () => {
    it("executeTunnel does not modify state", () => {
      const layout = makeLayout(1, 0);
      const state = makeState(0xCAFE, 0xBEEF);
      const highZs = new Uint32Array(state.length);
      executeTunnel(0, state, highZs, layout);
      expect(state[0]).toBe(0xCAFE);
      expect(state[1]).toBe(0xBEEF);
    });

    it("executeTunnel does not throw", () => {
      const layout = makeLayout(1, 0);
      const state = makeState(0);
      const highZs = new Uint32Array(state.length);
      expect(() => executeTunnel(0, state, highZs, layout)).not.toThrow();
    });
  });

  describe("sameNameConnection", () => {
    it("two Tunnels with same label have identical netName", () => {
      const t1 = makeTunnel("BUS_A");
      const t2 = makeTunnel("BUS_A");
      expect(t1.netName).toBe("BUS_A");
      expect(t2.netName).toBe("BUS_A");
      expect(t1.netName).toBe(t2.netName);
    });

    it("Tunnels with different labels have different netNames", () => {
      const t1 = makeTunnel("NET_1");
      const t2 = makeTunnel("NET_2");
      expect(t1.netName).not.toBe(t2.netName);
    });
  });

  describe("draw", () => {
    it("draw renders pentagon/flag shape with drawPolygon", () => {
      const el = makeTunnel("X");
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polyCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polyCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw shows label text when label is set", () => {
      const el = makeTunnel("DATA");
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "DATA")).toBe(true);
    });
  });

  describe("pins", () => {
    it("Tunnel has exactly 1 input pin", () => {
      const el = makeTunnel("X");
      const pins = el.getPins();
      expect(pins).toHaveLength(1);
      expect(pins[0].direction).toBe(PinDirection.INPUT);
    });

    it("Tunnel pin is labeled 'in'", () => {
      const el = makeTunnel("X");
      expect(el.getPins()[0].label).toBe("in");
    });
  });

  describe("attributeMapping", () => {
    it("NetName maps to NetName property key", () => {
      const m = TUNNEL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "NetName");
      expect(m).toBeDefined();
      expect(m!.convert("BUS_A")).toBe("BUS_A");
      expect(m!.propertyKey).toBe("NetName");
    });

    it("Bits maps to bitWidth", () => {
      const m = TUNNEL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.convert("4")).toBe(4);
    });
  });

  describe("definitionComplete", () => {
    it("TunnelDefinition name is 'Tunnel'", () => {
      expect(TunnelDefinition.name).toBe("Tunnel");
    });

    it("TunnelDefinition executeFn is executeTunnel", () => {
      expect(TunnelDefinition.executeFn).toBe(executeTunnel);
    });

    it("TunnelDefinition category is WIRING", () => {
      expect(TunnelDefinition.category).toBe(ComponentCategory.WIRING);
    });

    it("TunnelDefinition typeId is -1 sentinel", () => {
      expect(TunnelDefinition.typeId).toBe(-1);
    });

    it("TunnelDefinition can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(TunnelDefinition)).not.toThrow();
    });

    it("TunnelDefinition propertyDefs include NetName and bitWidth", () => {
      const keys = TunnelDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("NetName");
      expect(keys).toContain("bitWidth");
    });
  });
});
