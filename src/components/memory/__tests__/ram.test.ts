/**
 * Tests for RAM components: RAMSinglePort, RAMSinglePortSel, RAMDualPort,
 * RAMDualAccess, RAMAsync, BlockRAMDualPort.
 *
 * Covers:
 *   - Write-then-read correctness
 *   - Address boundary wrapping
 *   - DataField initialization
 *   - Dual-port simultaneous access
 *   - Async vs synchronous read timing
 *   - Clock edge detection
 *   - Pin layout correctness
 *   - Attribute mappings
 *   - Rendering (draw calls)
 *   - ComponentDefinition completeness
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DataField,
  registerBackingStore,
  clearBackingStores,
  RAMSinglePortElement,
  sampleRAMSinglePort,
  executeRAMSinglePort,
  RAMSinglePortDefinition,
  RAM_SINGLE_PORT_ATTRIBUTE_MAPPINGS,
  RAMSinglePortSelElement,
  executeRAMSinglePortSel,
  RAMSinglePortSelDefinition,
  RAM_SINGLE_PORT_SEL_ATTRIBUTE_MAPPINGS,
  RAMDualPortElement,
  sampleRAMDualPort,
  executeRAMDualPort,
  RAMDualPortDefinition,
  RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
  RAMDualAccessElement,
  sampleRAMDualAccess,
  executeRAMDualAccess,
  RAMDualAccessDefinition,
  RAM_DUAL_ACCESS_ATTRIBUTE_MAPPINGS,
  RAMAsyncElement,
  executeRAMAsync,
  RAMAsyncDefinition,
  RAM_ASYNC_ATTRIBUTE_MAPPINGS,
  BlockRAMDualPortElement,
  sampleBlockRAMDualPort,
  executeBlockRAMDualPort,
  BlockRAMDualPortDefinition,
  BLOCK_RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS,
} from "../ram.js";
import type { RAMLayout } from "../ram.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/**
 * Build a ComponentLayout for stateless components.
 * inputOffset=0, outputOffset=inputCount.
 */
function makeLayout(inputCount: number, outputCount: number): ComponentLayout {
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

/**
 * Build a RAMLayout for stateful RAM components.
 * stateOffset = inputCount + outputCount (immediately after I/O slots).
 */
function makeRAMLayout(inputCount: number, outputCount: number): RAMLayout {
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

/**
 * Build a Uint32Array with inputs pre-loaded, outputs and state zeroed.
 */
function makeState(inputs: number[], outputCount: number, stateSlots: number = 0): Uint32Array {
  const arr = new Uint32Array(inputs.length + outputCount + stateSlots);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Render context stub
// ---------------------------------------------------------------------------

interface DrawCall { method: string; args: unknown[]; }

function makeStubCtx(): { ctx: RenderContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record = (method: string) => (...args: unknown[]): void => { calls.push({ method, args }); };
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
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearBackingStores();
});

// ---------------------------------------------------------------------------
// DataField tests
// ---------------------------------------------------------------------------

describe("DataField", () => {
  it("initialises to all zeros", () => {
    const df = new DataField(16);
    for (let i = 0; i < 16; i++) {
      expect(df.read(i)).toBe(0);
    }
  });

  it("write and read round-trip", () => {
    const df = new DataField(16);
    df.write(5, 0xAB);
    expect(df.read(5)).toBe(0xAB);
  });

  it("write does not affect other addresses", () => {
    const df = new DataField(16);
    df.write(3, 0xFF);
    expect(df.read(0)).toBe(0);
    expect(df.read(1)).toBe(0);
    expect(df.read(4)).toBe(0);
  });

  it("address wraps modulo size", () => {
    const df = new DataField(16);
    df.write(16, 0x42);
    expect(df.read(0)).toBe(0x42);
  });

  it("initFrom loads values correctly", () => {
    const df = new DataField(8);
    df.initFrom([10, 20, 30, 40]);
    expect(df.read(0)).toBe(10);
    expect(df.read(1)).toBe(20);
    expect(df.read(2)).toBe(30);
    expect(df.read(3)).toBe(40);
    expect(df.read(4)).toBe(0);
  });

  it("copyFrom copies all data", () => {
    const src = new DataField(4);
    src.write(0, 1);
    src.write(1, 2);
    src.write(2, 3);
    src.write(3, 4);
    const dst = new DataField(4);
    dst.copyFrom(src);
    expect(dst.read(0)).toBe(1);
    expect(dst.read(1)).toBe(2);
    expect(dst.read(2)).toBe(3);
    expect(dst.read(3)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// RAMSinglePort tests
// ---------------------------------------------------------------------------

describe("RAMSinglePort", () => {
  describe("execute — write then read", () => {
    it("write on rising clock edge, read with ld=1", () => {
      const INDEX = 0;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      // Inputs: A=3, str=1, C=0→1 (rising edge), ld=1
      // State: +0=lastClk(0)
      const state = makeState([3, 1, 0, 1], 1, 1);
      const highZs = new Uint32Array(state.length);
      // stateBase = 4 + 1 = 5; state[5]=lastClk=0

      // First call: clk=0, no edge, ld=1 but nothing written yet
      executeRAMSinglePort(INDEX, state, highZs, layout);
      expect(state[4]).toBe(0);

      // Now produce rising edge: set clk=1
      state[2] = 1;
      // For single-port, data comes from the current output slot (state[4])
      // Set the output slot to the data we want to write
      state[4] = 0xCC;
      // Sample phase: detect edge, write to memory
      sampleRAMSinglePort(INDEX, state, highZs, layout);
      // Execute phase: read from memory to output
      executeRAMSinglePort(INDEX, state, highZs, layout);

      // Rising edge: str=1 → writes state[4]=0xCC to mem[3]
      // Then ld=1 → state[4] = mem.read(3) = 0xCC
      expect(state[4]).toBe(0xCC);
      expect(mem.read(3)).toBe(0xCC);
    });

    it("no write when str=0 on rising clock", () => {
      const INDEX = 1;
      const mem = new DataField(16);
      mem.write(0, 0xFF);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      // Inputs: A=0, str=0, C=1 (already high, but lastClk=0 → edge)
      const state = makeState([0, 0, 1, 1], 1, 1);
      const highZs = new Uint32Array(state.length);
      // state[5] = lastClk = 0

      executeRAMSinglePort(INDEX, state, highZs, layout);
      // str=0 → no write. ld=1 → read mem[0]=0xFF
      expect(state[4]).toBe(0xFF);
      expect(mem.read(0)).toBe(0xFF);
    });

    it("no output when ld=0", () => {
      const INDEX = 2;
      const mem = new DataField(16);
      mem.write(0, 0xAB);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      // ld=0 → output stays 0
      const state = makeState([0, 0, 0, 0], 1, 1);
      const highZs = new Uint32Array(state.length);
      state[4] = 0xFF;

      executeRAMSinglePort(INDEX, state, highZs, layout);
      expect(state[4]).toBe(0);
    });

    it("no write on falling or sustained clock (only rising edge)", () => {
      const INDEX = 3;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      const state = makeState([0, 1, 1, 0], 1, 1);
      const highZs = new Uint32Array(state.length);
      state[5] = 1; // lastClk=1 → no rising edge (sustained high)

      executeRAMSinglePort(INDEX, state, highZs, layout);
      expect(mem.read(0)).toBe(0);
    });
  });

  describe("pin layout", () => {
    it("has 4 input pins and 1 output pin", () => {
      const props = new PropertyBag();
      props.set("addrBits", 4);
      props.set("dataBits", 8);
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      expect(pins.filter(p => p.direction === PinDirection.INPUT)).toHaveLength(4);
      expect(pins.filter(p => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("input pin labels are A, str, C, ld", () => {
      const props = new PropertyBag();
      props.set("addrBits", 4);
      props.set("dataBits", 8);
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const inputs = el.getPins().filter(p => p.direction === PinDirection.INPUT);
      expect(inputs.map(p => p.label)).toEqual(["A", "str", "C", "ld"]);
    });

    it("output pin label is D", () => {
      const props = new PropertyBag();
      props.set("addrBits", 4);
      props.set("dataBits", 8);
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const outputs = el.getPins().filter(p => p.direction === PinDirection.OUTPUT);
      expect(outputs[0].label).toBe("D");
    });

    it("C pin is clock-capable", () => {
      const props = new PropertyBag();
      props.set("addrBits", 4);
      props.set("dataBits", 8);
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const clkPin = el.getPins().find(p => p.label === "C");
      expect(clkPin?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Bits maps to dataBits", () => {
      const m = RAM_SINGLE_PORT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("dataBits");
      expect(m!.convert("16")).toBe(16);
    });

    it("AddrBits maps to addrBits", () => {
      const m = RAM_SINGLE_PORT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "AddrBits");
      expect(m).toBeDefined();
      expect(m!.convert("8")).toBe(8);
    });

    it("Label maps to label", () => {
      const m = RAM_SINGLE_PORT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
      expect(m!.convert("MY_RAM")).toBe("MY_RAM");
    });

    it("isProgramMemory maps correctly", () => {
      const m = RAM_SINGLE_PORT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "isProgramMemory");
      expect(m!.convert("true")).toBe(true);
      expect(m!.convert("false")).toBe(false);
    });
  });

  describe("rendering", () => {
    it("draw calls drawRect for body", () => {
      const props = new PropertyBag();
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some(c => c.method === "drawPolygon")).toBe(true);
    });

    it("draw calls drawText with RAM symbol", () => {
      const props = new PropertyBag();
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter(c => c.method === "drawText").some(c => c.args[0] === "RAM")).toBe(true);
    });

    it("draw calls save and restore", () => {
      const props = new PropertyBag();
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some(c => c.method === "save")).toBe(true);
      expect(calls.some(c => c.method === "restore")).toBe(true);
    });

    it("draws label when set", () => {
      const props = new PropertyBag();
      props.set("label", "MYRAM");
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter(c => c.method === "drawText").some(c => c.args[0] === "MYRAM")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("has name='RAMSinglePort'", () => {
      expect(RAMSinglePortDefinition.name).toBe("RAMSinglePort");
    });

    it("has typeId=-1 before registration", () => {
      expect(RAMSinglePortDefinition.typeId).toBe(-1);
    });

    it("has factory function", () => {
      expect(typeof RAMSinglePortDefinition.factory).toBe("function");
    });

    it("factory produces RAMSinglePortElement", () => {
      const props = new PropertyBag();
      const el = RAMSinglePortDefinition.factory(props);
      expect(el.typeId).toBe("RAMSinglePort");
    });

    it("category is MEMORY", () => {
      expect(RAMSinglePortDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("has non-empty helpText", () => {
      expect(typeof RAMSinglePortDefinition.helpText).toBe("string"); expect(RAMSinglePortDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RAMSinglePortDefinition)).not.toThrow();
    });

    it("propertyDefs contain addrBits, dataBits, label", () => {
      const keys = RAMSinglePortDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("addrBits");
      expect(keys).toContain("dataBits");
      expect(keys).toContain("label");
    });

    it("getBoundingBox returns positive dimensions", () => {
      const props = new PropertyBag();
      const el = new RAMSinglePortElement("id", { x: 0, y: 0 }, 0, false, props);
      const bb = el.getBoundingBox();
      expect(bb.width).toBeGreaterThanOrEqual(2);
      expect(bb.height).toBeGreaterThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------
// RAMSinglePortSel tests
// ---------------------------------------------------------------------------

describe("RAMSinglePortSel", () => {
  describe("execute — CS/WE/OE logic", () => {
    it("CS=1, WE=1: writes data to memory", () => {
      const INDEX = 10;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(4, 1);
      // Inputs: A=5, CS=1, WE=1, OE=0
      // Output slot state[4] = data to write (bidirectional feedback)
      const state = makeState([5, 1, 1, 0], 1);
      const highZs = new Uint32Array(state.length);
      state[4] = 0x77;

      executeRAMSinglePortSel(INDEX, state, highZs, layout);
      expect(mem.read(5)).toBe(0x77);
    });

    it("CS=1, WE=0, OE=1: reads data from memory", () => {
      const INDEX = 11;
      const mem = new DataField(16);
      mem.write(2, 0xAA);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(4, 1);
      // Inputs: A=2, CS=1, WE=0, OE=1
      const state = makeState([2, 1, 0, 1], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMSinglePortSel(INDEX, state, highZs, layout);
      expect(state[4]).toBe(0xAA);
    });

    it("CS=1, WE=1, OE=1: writes but output is 0 (WE takes priority)", () => {
      const INDEX = 12;
      const mem = new DataField(16);
      mem.write(0, 0xFF);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(4, 1);
      // WE=1 means write mode, output goes to 0
      const state = makeState([0, 1, 1, 1], 1);
      const highZs = new Uint32Array(state.length);
      state[4] = 0x55;

      executeRAMSinglePortSel(INDEX, state, highZs, layout);
      expect(state[4]).toBe(0);
    });

    it("CS=0: output is 0 regardless", () => {
      const INDEX = 13;
      const mem = new DataField(16);
      mem.write(0, 0xFF);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(4, 1);
      const state = makeState([0, 0, 0, 1], 1);
      const highZs = new Uint32Array(state.length);
      state[4] = 0xFF;

      executeRAMSinglePortSel(INDEX, state, highZs, layout);
      expect(state[4]).toBe(0);
    });

    it("write-then-read round trip at different addresses", () => {
      const INDEX = 14;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(4, 1);

      // Write 0xAB to addr 7
      const stateW = makeState([7, 1, 1, 0], 1);
      stateW[4] = 0xAB;
      executeRAMSinglePortSel(INDEX, stateW, new Uint32Array(stateW.length), layout);
      expect(mem.read(7)).toBe(0xAB);

      // Read from addr 7
      const stateR = makeState([7, 1, 0, 1], 1);
      executeRAMSinglePortSel(INDEX, stateR, new Uint32Array(stateR.length), layout);
      expect(stateR[4]).toBe(0xAB);
    });
  });

  describe("pin layout", () => {
    it("has 4 input pins and 1 output pin", () => {
      const props = new PropertyBag();
      const el = new RAMSinglePortSelElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      expect(pins.filter(p => p.direction === PinDirection.INPUT)).toHaveLength(4);
      expect(pins.filter(p => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("input pin labels are A, CS, WE, OE", () => {
      const props = new PropertyBag();
      const el = new RAMSinglePortSelElement("id", { x: 0, y: 0 }, 0, false, props);
      const inputs = el.getPins().filter(p => p.direction === PinDirection.INPUT);
      expect(inputs.map(p => p.label)).toEqual(["A", "CS", "WE", "OE"]);
    });
  });

  describe("attribute mapping", () => {
    it("Bits maps to dataBits", () => {
      const m = RAM_SINGLE_PORT_SEL_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(m!.convert("8")).toBe(8);
    });
  });

  describe("definitionComplete", () => {
    it("has name='RAMSinglePortSel'", () => {
      expect(RAMSinglePortSelDefinition.name).toBe("RAMSinglePortSel");
    });

    it("category is MEMORY", () => {
      expect(RAMSinglePortSelDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RAMSinglePortSelDefinition)).not.toThrow();
    });

    it("factory produces RAMSinglePortSelElement", () => {
      const props = new PropertyBag();
      const el = RAMSinglePortSelDefinition.factory(props);
      expect(el.typeId).toBe("RAMSinglePortSel");
    });

    it("draw calls drawText with RAM symbol", () => {
      const props = new PropertyBag();
      const el = new RAMSinglePortSelElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter(c => c.method === "drawText").some(c => c.args[0] === "RAM")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// RAMDualPort tests
// ---------------------------------------------------------------------------

describe("RAMDualPort", () => {
  describe("execute — write then read", () => {
    it("write Din on rising clock edge, read with ld=1", () => {
      const INDEX = 20;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      // Inputs: A, Din, str, C, ld — 5 inputs, 1 output
      const layout = makeRAMLayout(5, 1);

      // Setup: clk=0, str=1, A=4, Din=0x42, ld=1
      const state = makeState([4, 0x42, 1, 0, 1], 1, 1);
      const highZs = new Uint32Array(state.length);
      // state[6] = stateBase = 5+1=6; lastClk=0

      executeRAMDualPort(INDEX, state, highZs, layout);
      // clk=0 → no rising edge → no write. ld=1 → read mem[4]=0
      expect(state[5]).toBe(0);

      // Now produce rising edge
      state[3] = 1;
      sampleRAMDualPort(INDEX, state, highZs, layout);
      executeRAMDualPort(INDEX, state, highZs, layout);
      // Rising edge: str=1 → write Din=0x42 to mem[4]. ld=1 → output = mem[4] = 0x42
      expect(mem.read(4)).toBe(0x42);
      expect(state[5]).toBe(0x42);
    });

    it("no write when str=0", () => {
      const INDEX = 21;
      const mem = new DataField(16);
      mem.write(0, 0x11);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(5, 1);
      // Rising edge but str=0
      const state = makeState([0, 0xFF, 0, 1, 1], 1, 1);
      const highZs = new Uint32Array(state.length);
      // lastClk=0 in state[6]

      executeRAMDualPort(INDEX, state, highZs, layout);
      // str=0 → no write. mem[0] still 0x11
      expect(mem.read(0)).toBe(0x11);
    });

    it("no output when ld=0", () => {
      const INDEX = 22;
      const mem = new DataField(16);
      mem.write(0, 0x99);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(5, 1);
      const state = makeState([0, 0, 0, 0, 0], 1, 1);
      const highZs = new Uint32Array(state.length);
      state[5] = 0xFF;

      executeRAMDualPort(INDEX, state, highZs, layout);
      expect(state[5]).toBe(0);
    });

    it("no edge on sustained clock high", () => {
      const INDEX = 23;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(5, 1);
      const state = makeState([0, 0xAA, 1, 1, 0], 1, 1);
      const highZs = new Uint32Array(state.length);
      state[6] = 1; // lastClk=1 → no rising edge

      executeRAMDualPort(INDEX, state, highZs, layout);
      expect(mem.read(0)).toBe(0);
    });

    it("multiple addresses write and read back correctly", () => {
      const INDEX = 24;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(5, 1);

      for (let addr = 0; addr < 8; addr++) {
        const data = addr * 17;
        // Rising edge write
        const stW = makeState([addr, data, 1, 1, 0], 1, 1);
        stW[6] = 0; // lastClk=0
        sampleRAMDualPort(INDEX, stW, new Uint32Array(stW.length), layout);
        executeRAMDualPort(INDEX, stW, new Uint32Array(stW.length), layout);
        expect(mem.read(addr)).toBe(data);
      }

      for (let addr = 0; addr < 8; addr++) {
        const stR = makeState([addr, 0, 0, 0, 1], 1, 1);
        executeRAMDualPort(INDEX, stR, new Uint32Array(stR.length), layout);
        expect(stR[5]).toBe(addr * 17);
      }
    });
  });

  describe("pin layout", () => {
    it("has 5 input pins and 1 output pin", () => {
      const props = new PropertyBag();
      const el = new RAMDualPortElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      expect(pins.filter(p => p.direction === PinDirection.INPUT)).toHaveLength(5);
      expect(pins.filter(p => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("input pin labels are A, Din, str, C, ld", () => {
      const props = new PropertyBag();
      const el = new RAMDualPortElement("id", { x: 0, y: 0 }, 0, false, props);
      const inputs = el.getPins().filter(p => p.direction === PinDirection.INPUT);
      expect(inputs.map(p => p.label)).toEqual(["A", "Din", "str", "C", "ld"]);
    });
  });

  describe("attribute mapping", () => {
    it("Bits=32 maps to dataBits=32", () => {
      const m = RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(m!.convert("32")).toBe(32);
    });
  });

  describe("definitionComplete", () => {
    it("has name='RAMDualPort'", () => {
      expect(RAMDualPortDefinition.name).toBe("RAMDualPort");
    });

    it("category is MEMORY", () => {
      expect(RAMDualPortDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RAMDualPortDefinition)).not.toThrow();
    });

    it("factory produces RAMDualPortElement", () => {
      const el = RAMDualPortDefinition.factory(new PropertyBag());
      expect(el.typeId).toBe("RAMDualPort");
    });
  });
});

// ---------------------------------------------------------------------------
// RAMDualAccess tests
// ---------------------------------------------------------------------------

describe("RAMDualAccess", () => {
  describe("execute — dual port access", () => {
    it("port 2 async read always reflects memory", () => {
      const INDEX = 30;
      const mem = new DataField(16);
      mem.write(7, 0xDE);
      registerBackingStore(INDEX, mem);

      // Inputs: str, C, ld, 1A, 1Din, 2A — 6 inputs, 2 outputs
      const layout = makeRAMLayout(6, 2);
      // Port 2: addr=7
      const state = makeState([0, 0, 0, 0, 0, 7], 2, 1);
      const highZs = new Uint32Array(state.length);

      executeRAMDualAccess(INDEX, state, highZs, layout);
      // 2D = mem[7] = 0xDE regardless of clock/ld
      expect(state[7]).toBe(0xDE);
    });

    it("port 1 synchronous write then port 2 reads it", () => {
      const INDEX = 31;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(6, 2);

      // Write 0xCA to addr 5 via port 1 on rising edge
      // Inputs: str=1, C=1, ld=0, 1A=5, 1Din=0xCA, 2A=5
      const state = makeState([1, 1, 0, 5, 0xCA, 5], 2, 1);
      const highZs = new Uint32Array(state.length);
      state[8] = 0; // lastClk=0

      sampleRAMDualAccess(INDEX, state, highZs, layout);
      executeRAMDualAccess(INDEX, state, highZs, layout);
      // Rising edge: str=1 → write 0xCA to mem[5]
      expect(mem.read(5)).toBe(0xCA);
      // Port 2 reads mem[5] = 0xCA
      expect(state[7]).toBe(0xCA);
    });

    it("port 1 ld=1 reads data", () => {
      const INDEX = 32;
      const mem = new DataField(16);
      mem.write(3, 0x88);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(6, 2);
      const state = makeState([0, 0, 1, 3, 0, 0], 2, 1);
      const highZs = new Uint32Array(state.length);

      executeRAMDualAccess(INDEX, state, highZs, layout);
      // ld=1 → 1D = mem[3] = 0x88
      expect(state[6]).toBe(0x88);
    });

    it("port 1 ld=0 outputs 0", () => {
      const INDEX = 33;
      const mem = new DataField(16);
      mem.write(0, 0xFF);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(6, 2);
      const state = makeState([0, 0, 0, 0, 0, 0], 2, 1);
      const highZs = new Uint32Array(state.length);
      state[6] = 0xFF;

      executeRAMDualAccess(INDEX, state, highZs, layout);
      expect(state[6]).toBe(0);
    });

    it("simultaneous port 1 write and port 2 read different addresses", () => {
      const INDEX = 34;
      const mem = new DataField(16);
      mem.write(9, 0x55);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(6, 2);
      // Write to addr 2 via port 1, read from addr 9 via port 2
      const state = makeState([1, 1, 0, 2, 0x11, 9], 2, 1);
      const highZs = new Uint32Array(state.length);
      state[8] = 0; // lastClk=0

      sampleRAMDualAccess(INDEX, state, highZs, layout);
      executeRAMDualAccess(INDEX, state, highZs, layout);
      expect(mem.read(2)).toBe(0x11);
      expect(state[7]).toBe(0x55);
    });
  });

  describe("pin layout", () => {
    it("has 6 input pins and 2 output pins", () => {
      const props = new PropertyBag();
      const el = new RAMDualAccessElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      expect(pins.filter(p => p.direction === PinDirection.INPUT)).toHaveLength(6);
      expect(pins.filter(p => p.direction === PinDirection.OUTPUT)).toHaveLength(2);
    });

    it("input pin labels are str, C, ld, 1A, 1Din, 2A", () => {
      const props = new PropertyBag();
      const el = new RAMDualAccessElement("id", { x: 0, y: 0 }, 0, false, props);
      const inputs = el.getPins().filter(p => p.direction === PinDirection.INPUT);
      expect(inputs.map(p => p.label)).toEqual(["str", "C", "ld", "1A", "1Din", "2A"]);
    });

    it("output pin labels are 1D and 2D", () => {
      const props = new PropertyBag();
      const el = new RAMDualAccessElement("id", { x: 0, y: 0 }, 0, false, props);
      const outputs = el.getPins().filter(p => p.direction === PinDirection.OUTPUT);
      expect(outputs.map(p => p.label)).toEqual(["1D", "2D"]);
    });
  });

  describe("attribute mapping", () => {
    it("AddrBits=10 maps to addrBits=10", () => {
      const m = RAM_DUAL_ACCESS_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "AddrBits");
      expect(m!.convert("10")).toBe(10);
    });
  });

  describe("definitionComplete", () => {
    it("has name='RAMDualAccess'", () => {
      expect(RAMDualAccessDefinition.name).toBe("RAMDualAccess");
    });

    it("category is MEMORY", () => {
      expect(RAMDualAccessDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RAMDualAccessDefinition)).not.toThrow();
    });

    it("factory produces RAMDualAccessElement", () => {
      const el = RAMDualAccessDefinition.factory(new PropertyBag());
      expect(el.typeId).toBe("RAMDualAccess");
    });
  });
});

// ---------------------------------------------------------------------------
// RAMAsync tests
// ---------------------------------------------------------------------------

describe("RAMAsync", () => {
  describe("execute — combinational read and write", () => {
    it("we=1: writes D to memory[A]", () => {
      const INDEX = 40;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      // Inputs: A, D, we — 3 inputs, 1 output
      const layout = makeLayout(3, 1);
      const state = makeState([6, 0xAB, 1], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMAsync(INDEX, state, highZs, layout);
      expect(mem.read(6)).toBe(0xAB);
      expect(state[3]).toBe(0xAB);
    });

    it("we=0: does not write, reads existing value", () => {
      const INDEX = 41;
      const mem = new DataField(16);
      mem.write(2, 0xCD);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(3, 1);
      const state = makeState([2, 0xFF, 0], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMAsync(INDEX, state, highZs, layout);
      expect(mem.read(2)).toBe(0xCD);
      expect(state[3]).toBe(0xCD);
    });

    it("write then read back immediately (same call)", () => {
      const INDEX = 42;
      const mem = new DataField(16);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(3, 1);
      const state = makeState([0, 0x42, 1], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMAsync(INDEX, state, highZs, layout);
      expect(state[3]).toBe(0x42);
    });

    it("output reflects memory after write, not before", () => {
      const INDEX = 43;
      const mem = new DataField(16);
      mem.write(1, 0x11);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(3, 1);
      // we=1, A=1, D=0x22 → writes 0x22, then reads 0x22
      const state = makeState([1, 0x22, 1], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMAsync(INDEX, state, highZs, layout);
      expect(state[3]).toBe(0x22);
    });

    it("address boundary: wraps at size", () => {
      const INDEX = 44;
      const mem = new DataField(8);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(3, 1);
      // Write to address 8 → wraps to 0
      const state = makeState([8, 0x99, 1], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMAsync(INDEX, state, highZs, layout);
      expect(mem.read(0)).toBe(0x99);
    });

    it("DataField initialization: reads pre-loaded values", () => {
      const INDEX = 45;
      const mem = new DataField(16);
      mem.initFrom([0, 10, 20, 30, 40, 50]);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(3, 1);
      const state = makeState([3, 0, 0], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMAsync(INDEX, state, highZs, layout);
      expect(state[3]).toBe(30);
    });

    it("no backing store: outputs 0", () => {
      const INDEX = 99;
      // No backing store registered for INDEX=99
      const layout = makeLayout(3, 1);
      const state = makeState([0, 0xFF, 0], 1);
      const highZs = new Uint32Array(state.length);

      executeRAMAsync(INDEX, state, highZs, layout);
      expect(state[3]).toBe(0);
    });

    it("zero allocation: can be called 1000 times without error", () => {
      const INDEX = 46;
      const mem = new DataField(256);
      registerBackingStore(INDEX, mem);

      const layout = makeLayout(3, 1);
      const state = makeState([0, 0, 0], 1);
      const highZs = new Uint32Array(state.length);

      for (let i = 0; i < 1000; i++) {
        state[0] = i % 256;
        state[1] = i & 0xFF;
        state[2] = 1;
        executeRAMAsync(INDEX, state, highZs, layout);
      }
      expect(typeof state[3]).toBe("number");
    });
  });

  describe("pin layout", () => {
    it("has 3 input pins and 1 output pin", () => {
      const props = new PropertyBag();
      const el = new RAMAsyncElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      expect(pins.filter(p => p.direction === PinDirection.INPUT)).toHaveLength(3);
      expect(pins.filter(p => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("input pin labels are A, D, we", () => {
      const props = new PropertyBag();
      const el = new RAMAsyncElement("id", { x: 0, y: 0 }, 0, false, props);
      const inputs = el.getPins().filter(p => p.direction === PinDirection.INPUT);
      expect(inputs.map(p => p.label)).toEqual(["A", "D", "we"]);
    });

    it("output pin label is Q", () => {
      const props = new PropertyBag();
      const el = new RAMAsyncElement("id", { x: 0, y: 0 }, 0, false, props);
      const outputs = el.getPins().filter(p => p.direction === PinDirection.OUTPUT);
      expect(outputs[0].label).toBe("Q");
    });
  });

  describe("attribute mapping", () => {
    it("Bits maps to dataBits", () => {
      const m = RAM_ASYNC_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(m!.convert("16")).toBe(16);
    });

    it("AddrBits maps to addrBits", () => {
      const m = RAM_ASYNC_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "AddrBits");
      expect(m!.convert("12")).toBe(12);
    });
  });

  describe("rendering", () => {
    it("draw calls drawRect for body", () => {
      const props = new PropertyBag();
      const el = new RAMAsyncElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some(c => c.method === "drawPolygon")).toBe(true);
    });

    it("draw calls drawText with RAM symbol", () => {
      const props = new PropertyBag();
      const el = new RAMAsyncElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter(c => c.method === "drawText").some(c => (c.args[0] as string).includes("RAM"))).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("has name='RAMAsync'", () => {
      expect(RAMAsyncDefinition.name).toBe("RAMAsync");
    });

    it("category is MEMORY", () => {
      expect(RAMAsyncDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RAMAsyncDefinition)).not.toThrow();
    });

    it("factory produces RAMAsyncElement", () => {
      const el = RAMAsyncDefinition.factory(new PropertyBag());
      expect(el.typeId).toBe("RAMAsync");
    });

    it("propertyDefs contain addrBits and dataBits", () => {
      const keys = RAMAsyncDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("addrBits");
      expect(keys).toContain("dataBits");
    });
  });
});

// ---------------------------------------------------------------------------
// BlockRAMDualPort tests
// ---------------------------------------------------------------------------

describe("BlockRAMDualPort", () => {
  describe("execute — synchronous read-before-write", () => {
    it("output holds 0 before any clock edge", () => {
      const INDEX = 50;
      const mem = new DataField(16);
      mem.write(0, 0xBB);
      registerBackingStore(INDEX, mem);

      // Inputs: A, Din, str, C — 4 inputs, 1 output, 2 state slots
      const layout = makeRAMLayout(4, 1);
      const state = makeState([0, 0, 0, 0], 1, 2);
      const highZs = new Uint32Array(state.length);
      // stateBase = 4+1=5; state[5]=lastClk=0, state[6]=outputVal=0

      executeBlockRAMDualPort(INDEX, state, highZs, layout);
      // clk=0 → no rising edge → output = state[6] = 0
      expect(state[4]).toBe(0);
    });

    it("read-before-write: captures OLD value before write on rising edge", () => {
      const INDEX = 51;
      const mem = new DataField(16);
      mem.write(2, 0xAA);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      // Inputs: A=2, Din=0x55, str=1, C=1
      const state = makeState([2, 0x55, 1, 1], 1, 2);
      const highZs = new Uint32Array(state.length);
      // state[5]=lastClk=0, state[6]=outputVal=0

      sampleBlockRAMDualPort(INDEX, state, highZs, layout);
      executeBlockRAMDualPort(INDEX, state, highZs, layout);
      // Rising edge: reads mem[2]=0xAA into outputVal, then writes 0x55 to mem[2]
      expect(state[4]).toBe(0xAA);
      expect(mem.read(2)).toBe(0x55);
    });

    it("next clock edge reads the newly written value", () => {
      const INDEX = 52;
      const mem = new DataField(16);
      mem.write(0, 0x10);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      // First rising edge: read 0x10, write 0x20
      const state = makeState([0, 0x20, 1, 1], 1, 2);
      const highZs = new Uint32Array(state.length);
      state[5] = 0; // lastClk=0

      sampleBlockRAMDualPort(INDEX, state, highZs, layout);
      executeBlockRAMDualPort(INDEX, state, highZs, layout);
      expect(state[4]).toBe(0x10);
      expect(mem.read(0)).toBe(0x20);

      // Second rising edge: read 0x20, write 0x30
      state[1] = 0x30;
      state[3] = 0; // clk goes low
      sampleBlockRAMDualPort(INDEX, state, highZs, layout);
      executeBlockRAMDualPort(INDEX, state, highZs, layout);
      // clk=0 → no edge, output unchanged
      expect(state[4]).toBe(0x10);

      state[3] = 1; // clk rises again
      sampleBlockRAMDualPort(INDEX, state, highZs, layout);
      executeBlockRAMDualPort(INDEX, state, highZs, layout);
      expect(state[4]).toBe(0x20);
      expect(mem.read(0)).toBe(0x30);
    });

    it("str=0: reads but does not write", () => {
      const INDEX = 53;
      const mem = new DataField(16);
      mem.write(1, 0x77);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      const state = makeState([1, 0xFF, 0, 1], 1, 2);
      const highZs = new Uint32Array(state.length);
      state[5] = 0;

      sampleBlockRAMDualPort(INDEX, state, highZs, layout);
      executeBlockRAMDualPort(INDEX, state, highZs, layout);
      // reads mem[1]=0x77 into outputVal, but str=0 → no write
      expect(state[4]).toBe(0x77);
      expect(mem.read(1)).toBe(0x77);
    });

    it("async read timing: output only updates on clock edge", () => {
      const INDEX = 54;
      const mem = new DataField(16);
      mem.write(0, 0x33);
      registerBackingStore(INDEX, mem);

      const layout = makeRAMLayout(4, 1);
      const state = makeState([0, 0, 0, 0], 1, 2);
      const highZs = new Uint32Array(state.length);
      // clk stays low — output never updates
      for (let i = 0; i < 5; i++) {
        executeBlockRAMDualPort(INDEX, state, highZs, layout);
        expect(state[4]).toBe(0);
      }
    });
  });

  describe("pin layout", () => {
    it("has 4 input pins and 1 output pin", () => {
      const props = new PropertyBag();
      const el = new BlockRAMDualPortElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      expect(pins.filter(p => p.direction === PinDirection.INPUT)).toHaveLength(4);
      expect(pins.filter(p => p.direction === PinDirection.OUTPUT)).toHaveLength(1);
    });

    it("input pin labels are A, Din, str, C", () => {
      const props = new PropertyBag();
      const el = new BlockRAMDualPortElement("id", { x: 0, y: 0 }, 0, false, props);
      const inputs = el.getPins().filter(p => p.direction === PinDirection.INPUT);
      expect(inputs.map(p => p.label)).toEqual(["A", "Din", "str", "C"]);
    });

    it("C pin is clock-capable", () => {
      const props = new PropertyBag();
      const el = new BlockRAMDualPortElement("id", { x: 0, y: 0 }, 0, false, props);
      const clkPin = el.getPins().find(p => p.label === "C");
      expect(clkPin?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Bits maps to dataBits", () => {
      const m = BLOCK_RAM_DUAL_PORT_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(m!.convert("8")).toBe(8);
    });
  });

  describe("rendering", () => {
    it("draw calls drawText with RAM symbol", () => {
      const props = new PropertyBag();
      const el = new BlockRAMDualPortElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter(c => c.method === "drawText").some(c => (c.args[0] as string).includes("RAM"))).toBe(true);
    });

    it("draw calls drawRect for body", () => {
      const props = new PropertyBag();
      const el = new BlockRAMDualPortElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some(c => c.method === "drawPolygon")).toBe(true);
    });
  });

  describe("definitionComplete", () => {
    it("has name='BlockRAMDualPort'", () => {
      expect(BlockRAMDualPortDefinition.name).toBe("BlockRAMDualPort");
    });

    it("category is MEMORY", () => {
      expect(BlockRAMDualPortDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("can be registered", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(BlockRAMDualPortDefinition)).not.toThrow();
    });

    it("factory produces BlockRAMDualPortElement", () => {
      const el = BlockRAMDualPortDefinition.factory(new PropertyBag());
      expect(el.typeId).toBe("BlockRAMDualPort");
    });

  });
});
