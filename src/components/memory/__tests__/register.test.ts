/**
 * Tests for Register and RegisterFile components (Task 5.2.8).
 *
 * Covers:
 *   Register:
 *     - Store D input on rising clock edge when en=1
 *     - Enable gate: no store when en=0
 *     - Output Q reflects stored value
 *     - Edge detection (only rising edge captures)
 *     - Pin layout
 *     - Attribute mapping
 *     - ComponentDefinition completeness
 *     - Rendering
 *
 *   RegisterFile:
 *     - Write Din to register[Rw] on rising clock edge when we=1
 *     - No write when we=0
 *     - Read Da = register[Ra], Db = register[Rb] combinationally
 *     - Simultaneous read and write (write-then-read same cycle)
 *     - Multi-register independence
 *     - Address masking
 *     - Pin layout
 *     - Attribute mapping
 *     - ComponentDefinition completeness
 *     - Rendering
 */

import { describe, it, expect } from "vitest";
import {
  RegisterElement,
  executeRegister,
  RegisterDefinition,
  REGISTER_ATTRIBUTE_MAPPINGS,
} from "../register.js";
import {
  RegisterFileElement,
  executeRegisterFile,
  RegisterFileDefinition,
  REGISTER_FILE_ATTRIBUTE_MAPPINGS,
} from "../register-file.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LayoutWithState extends ComponentLayout {
  stateOffset(componentIndex: number): number;
  getProperty(componentIndex: number, key: string): number;
}

/**
 * Build a minimal layout for Register.
 * Inputs at 0..inputCount-1, outputs at inputCount.., state at inputCount+outputCount..
 */
function makeLayout(
  inputCount: number,
  outputCount: number,
  props?: Record<string, number>,
): LayoutWithState {
  const outputStart = inputCount;
  const stateStart = inputCount + outputCount;
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => outputStart,
    stateOffset: () => stateStart,
    getProperty: (_i: number, key: string) => (props && key in props ? props[key] : 0),
  };
}

function makeState(totalSlots: number, initial?: Partial<Record<number, number>>): Uint32Array {
  const arr = new Uint32Array(totalSlots);
  if (initial) {
    for (const [idx, val] of Object.entries(initial)) {
      arr[parseInt(idx, 10)] = val as number;
    }
  }
  return arr;
}

interface DrawCall { method: string; args: unknown[] }

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
// Register tests
// ---------------------------------------------------------------------------

// Slot map for Register: [D=0, C=1, en=2, Q=3, storedVal=4, prevClock=5]
// total = 6 slots (3 inputs + 1 output + 2 state)

describe("Register", () => {
  describe("store and recall", () => {
    it("captures D on rising clock edge when en=1", () => {
      const layout = makeLayout(3, 1);
      // slots: [D=0, C=1, en=2, Q=3, storedVal=4, prevClock=5]
      const state = makeState(6, { 0: 42, 1: 0, 2: 1, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1; // rising edge
      executeRegister(0, state, highZs, layout);
      expect(state[3]).toBe(42); // Q = stored value
      expect(state[4]).toBe(42); // storedVal updated
    });

    it("Q reflects stored value after multiple clocks", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6, { 0: 10, 1: 0, 2: 1, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      // First rising edge — store 10
      state[1] = 1;
      executeRegister(0, state, highZs, layout);
      expect(state[3]).toBe(10);
      // Clock falls
      state[5] = 1; // prevClock = 1
      state[1] = 0;
      executeRegister(0, state, highZs, layout);
      expect(state[3]).toBe(10); // still 10
      // New value on D but no rising edge
      state[0] = 99;
      executeRegister(0, state, highZs, layout);
      expect(state[3]).toBe(10); // still 10
    });

    it("initial Q is 0 before any clock edge", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6);
      const highZs = new Uint32Array(state.length);
      executeRegister(0, state, highZs, layout);
      expect(state[3]).toBe(0);
    });
  });

  describe("enable gate", () => {
    it("does not capture D when en=0 on rising edge", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6, { 0: 77, 1: 0, 2: 0, 4: 55, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1; // rising edge
      executeRegister(0, state, highZs, layout);
      expect(state[4]).toBe(55); // storedVal unchanged
      expect(state[3]).toBe(55); // Q = old stored value
    });

    it("captures D when en=1 after previously disabled", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6, { 0: 77, 1: 0, 2: 0, 4: 55, 5: 0 });
      const highZs = new Uint32Array(state.length);
      // Rising edge but en=0 → no capture
      state[1] = 1;
      executeRegister(0, state, highZs, layout);
      expect(state[4]).toBe(55);
      // Fall + re-arm
      state[5] = 1; state[1] = 0;
      executeRegister(0, state, highZs, layout);
      // New rising edge with en=1
      state[2] = 1; state[5] = 0; state[1] = 1;
      executeRegister(0, state, highZs, layout);
      expect(state[4]).toBe(77);
      expect(state[3]).toBe(77);
    });
  });

  describe("edge detection", () => {
    it("does not capture when clock stays high", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6, { 0: 99, 1: 1, 2: 1, 4: 7, 5: 1 });
      const highZs = new Uint32Array(state.length);
      executeRegister(0, state, highZs, layout);
      expect(state[4]).toBe(7); // no change
    });

    it("does not capture on falling edge", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6, { 0: 99, 1: 0, 2: 1, 4: 7, 5: 1 });
      const highZs = new Uint32Array(state.length);
      executeRegister(0, state, highZs, layout);
      expect(state[4]).toBe(7); // no change
    });

    it("prevClock is updated after each call", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6, { 0: 0, 1: 1, 2: 0, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      executeRegister(0, state, highZs, layout);
      expect(state[5]).toBe(1); // prevClock = clock
    });
  });

  describe("bit width", () => {
    it("stores wide values correctly (8-bit)", () => {
      const layout = makeLayout(3, 1);
      const state = makeState(6, { 0: 0xFF, 1: 0, 2: 1, 4: 0, 5: 0 });
      const highZs = new Uint32Array(state.length);
      state[1] = 1;
      executeRegister(0, state, highZs, layout);
      expect(state[3]).toBe(0xFF);
    });
  });

  describe("pin layout", () => {
    it("has 3 inputs (D, C, en) and 1 output (Q)", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      const el = new RegisterElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(1);
      expect(inputs.map(p => p.label)).toEqual(["D", "C", "en"]);
      expect(outputs[0].label).toBe("Q");
    });

    it("C pin is marked as isClock=true", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      const el = new RegisterElement("id", { x: 0, y: 0 }, 0, false, props);
      const c = el.getPins().find(p => p.label === "C");
      expect(c?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Bits maps to bitWidth as integer", () => {
      const mapping = REGISTER_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("bitWidth");
      expect(mapping!.convert("16")).toBe(16);
    });

    it("Label maps to label key", () => {
      const mapping = REGISTER_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("reg1")).toBe("reg1");
    });
  });

  describe("definition completeness", () => {
    it("RegisterDefinition has name='Register'", () => {
      expect(RegisterDefinition.name).toBe("Register");
    });

    it("RegisterDefinition has typeId=-1 sentinel", () => {
      expect(RegisterDefinition.typeId).toBe(-1);
    });

    it("RegisterDefinition category is MEMORY", () => {
      expect(RegisterDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("RegisterDefinition has executeFn=executeRegister", () => {
      expect(RegisterDefinition.models.digital!.executeFn).toBe(executeRegister);
    });

    it("RegisterDefinition propertyDefs include bitWidth", () => {
      const keys = RegisterDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("bitWidth");
    });

    it("RegisterDefinition has non-empty helpText", () => {
      expect(typeof RegisterDefinition.helpText).toBe("string"); expect(RegisterDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("RegisterDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RegisterDefinition)).not.toThrow();
    });

    it("RegisterDefinition factory produces a RegisterElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      const el = RegisterDefinition.factory(props);
      expect(el.typeId).toBe("Register");
    });
  });

  describe("rendering", () => {
    it("draw() calls drawPolygon for body", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      const el = new RegisterElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter(c => c.method === "drawPolygon").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders D, C, en, Q labels", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      const el = new RegisterElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("D");
      expect(texts).toContain("C");
      expect(texts).toContain("en");
      expect(texts).toContain("Q");
    });

    it("draw() renders component label when set", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("label", "PC");
      const el = new RegisterElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("PC");
    });
  });
});

// ---------------------------------------------------------------------------
// RegisterFile tests
// ---------------------------------------------------------------------------

// Slot map for RegisterFile (addrBits=2, numRegs=4):
// inputs: [Din=0, we=1, Rw=2, C=3, Ra=4, Rb=5]
// outputs: [Da=6, Db=7]
// state:  [prevClock=8, reg0=9, reg1=10, reg2=11, reg3=12]
// total = 13 slots

function makeRegFileLayout(addrBits: number): LayoutWithState {
  const inputCount = 6;
  const outputCount = 2;
  const outputStart = inputCount;
  const stateStart = inputCount + outputCount;
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => outputStart,
    stateOffset: () => stateStart,
    getProperty: (_i: number, key: string) => {
      if (key === "addrBits") return addrBits;
      return 0;
    },
  };
}

describe("RegisterFile", () => {
  describe("write and read", () => {
    it("writes Din to register[Rw] on rising clock edge when we=1", () => {
      const layout = makeRegFileLayout(2); // 4 registers
      // total slots: 6 inputs + 2 outputs + 1 prevClock + 4 regs = 13
      const state = makeState(13);
      const highZs = new Uint32Array(state.length);
      // Din=0xAB, we=1, Rw=2, C rising, Ra=2, Rb=0
      state[0] = 0xAB; state[1] = 1; state[2] = 2; state[3] = 1; state[4] = 2; state[5] = 0;
      executeRegisterFile(0, state, highZs, layout);
      // Da should reflect register[2] = 0xAB
      expect(state[6]).toBe(0xAB);
    });

    it("does not write when we=0", () => {
      const layout = makeRegFileLayout(2);
      const state = makeState(13, { 9: 0, 10: 0, 11: 55, 12: 0 }); // reg2=55
      const highZs = new Uint32Array(state.length);
      state[0] = 0xFF; state[1] = 0; state[2] = 2; state[3] = 1; state[4] = 2; state[5] = 0;
      executeRegisterFile(0, state, highZs, layout);
      expect(state[11]).toBe(55); // register[2] unchanged
      expect(state[6]).toBe(55); // Da = 55
    });

    it("combinational read: Da = register[Ra], Db = register[Rb]", () => {
      const layout = makeRegFileLayout(2);
      const state = makeState(13, { 9: 10, 10: 20, 11: 30, 12: 40 }); // regs 0–3
      const highZs = new Uint32Array(state.length);
      // No clock edge; just read
      state[4] = 1; state[5] = 3; // Ra=1, Rb=3
      executeRegisterFile(0, state, highZs, layout);
      expect(state[6]).toBe(20); // Da = reg[1] = 20
      expect(state[7]).toBe(40); // Db = reg[3] = 40
    });

    it("reads reflect value written in same call (write then read)", () => {
      const layout = makeRegFileLayout(2);
      const state = makeState(13);
      const highZs = new Uint32Array(state.length);
      // Write 0x55 to reg[1], read Ra=1, Rb=1
      state[0] = 0x55; state[1] = 1; state[2] = 1; state[3] = 1; state[4] = 1; state[5] = 1;
      executeRegisterFile(0, state, highZs, layout);
      expect(state[6]).toBe(0x55); // Da = reg[1] written this cycle
      expect(state[7]).toBe(0x55); // Db = reg[1] written this cycle
    });
  });

  describe("multi-register independence", () => {
    it("writing to reg[0] does not affect reg[1]", () => {
      const layout = makeRegFileLayout(2);
      const state = makeState(13, { 10: 99 }); // reg[1] = 99
      const highZs = new Uint32Array(state.length);
      state[0] = 42; state[1] = 1; state[2] = 0; state[3] = 1; state[4] = 1; state[5] = 1;
      executeRegisterFile(0, state, highZs, layout);
      expect(state[10]).toBe(99); // reg[1] unchanged
      expect(state[6]).toBe(99); // Da = reg[1] = 99
    });

    it("independent writes to all 4 registers", () => {
      const layout = makeRegFileLayout(2);
      const state = makeState(13);
      const highZs = new Uint32Array(state.length);

      const writeReg = (addr: number, val: number): void => {
        state[8] = 0; // reset prevClock
        state[0] = val; state[1] = 1; state[2] = addr; state[3] = 1;
        executeRegisterFile(0, state, highZs, layout);
        state[3] = 0; // clock falls
        state[8] = 1; // prevClock = 1 after fall
        executeRegisterFile(0, state, highZs, layout);
        state[8] = 0; // ready for next rising edge
      };

      writeReg(0, 10); writeReg(1, 20); writeReg(2, 30); writeReg(3, 40);

      state[4] = 0; state[5] = 3;
      executeRegisterFile(0, state, highZs, layout);
      expect(state[6]).toBe(10); // Da = reg[0]
      expect(state[7]).toBe(40); // Db = reg[3]
    });
  });

  describe("edge detection", () => {
    it("does not write when clock stays high (no new rising edge)", () => {
      const layout = makeRegFileLayout(2);
      const state = makeState(13, { 11: 77 }); // reg[2] = 77
      const highZs = new Uint32Array(state.length);
      state[0] = 0xFF; state[1] = 1; state[2] = 2; state[3] = 1; state[4] = 2; state[8] = 1; // prevClock=1
      executeRegisterFile(0, state, highZs, layout);
      expect(state[11]).toBe(77); // no write
    });

    it("prevClock is updated after each call", () => {
      const layout = makeRegFileLayout(2);
      const state = makeState(13);
      const highZs = new Uint32Array(state.length);
      state[3] = 1; // clock high
      executeRegisterFile(0, state, highZs, layout);
      expect(state[8]).toBe(1); // prevClock updated
    });
  });

  describe("address masking", () => {
    it("address wraps modulo numRegs", () => {
      const layout = makeRegFileLayout(2); // 4 registers, mask = 3
      const state = makeState(13, { 9: 55 }); // reg[0] = 55
      const highZs = new Uint32Array(state.length);
      // Ra = 4 (should wrap to 0)
      state[4] = 4; state[5] = 0;
      executeRegisterFile(0, state, highZs, layout);
      expect(state[6]).toBe(55); // Da = reg[4 & 3] = reg[0] = 55
    });
  });

  describe("addrBits=1 (2 registers)", () => {
    it("writes and reads 2 registers correctly", () => {
      const layout = makeRegFileLayout(1); // 2 registers
      // total slots: 6 inputs + 2 outputs + 1 prevClock + 2 regs = 11
      const state = makeState(11);
      const highZs = new Uint32Array(state.length);
      state[0] = 0xAA; state[1] = 1; state[2] = 0; state[3] = 1; state[4] = 0; state[5] = 0;
      executeRegisterFile(0, state, highZs, layout);
      expect(state[6]).toBe(0xAA);
    });
  });

  describe("pin layout", () => {
    it("has 6 inputs and 2 outputs", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("addrBits", 2);
      const el = new RegisterFileElement("id", { x: 0, y: 0 }, 0, false, props);
      const pins = el.getPins();
      const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
      const outputs = pins.filter(p => p.direction === PinDirection.OUTPUT);
      expect(inputs).toHaveLength(6);
      expect(outputs).toHaveLength(2);
      expect(inputs.map(p => p.label)).toEqual(["Din", "we", "Rw", "C", "Ra", "Rb"]);
      expect(outputs.map(p => p.label)).toEqual(["Da", "Db"]);
    });

    it("C pin is marked as isClock=true", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("addrBits", 2);
      const el = new RegisterFileElement("id", { x: 0, y: 0 }, 0, false, props);
      const c = el.getPins().find(p => p.label === "C");
      expect(c?.isClock).toBe(true);
    });
  });

  describe("attribute mapping", () => {
    it("Bits maps to bitWidth as integer", () => {
      const mapping = REGISTER_FILE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("bitWidth");
      expect(mapping!.convert("16")).toBe(16);
    });

    it("AddrBits maps to addrBits as integer", () => {
      const mapping = REGISTER_FILE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "AddrBits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("addrBits");
      expect(mapping!.convert("3")).toBe(3);
    });

    it("Label maps to label key", () => {
      const mapping = REGISTER_FILE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("rf1")).toBe("rf1");
    });
  });

  describe("definition completeness", () => {
    it("RegisterFileDefinition has name='RegisterFile'", () => {
      expect(RegisterFileDefinition.name).toBe("RegisterFile");
    });

    it("RegisterFileDefinition has typeId=-1 sentinel", () => {
      expect(RegisterFileDefinition.typeId).toBe(-1);
    });

    it("RegisterFileDefinition category is MEMORY", () => {
      expect(RegisterFileDefinition.category).toBe(ComponentCategory.MEMORY);
    });

    it("RegisterFileDefinition has executeFn=executeRegisterFile", () => {
      expect(RegisterFileDefinition.models.digital!.executeFn).toBe(executeRegisterFile);
    });

    it("RegisterFileDefinition propertyDefs include bitWidth and addrBits", () => {
      const keys = RegisterFileDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("bitWidth");
      expect(keys).toContain("addrBits");
    });

    it("RegisterFileDefinition has non-empty helpText", () => {
      expect(typeof RegisterFileDefinition.helpText).toBe("string"); expect(RegisterFileDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("RegisterFileDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RegisterFileDefinition)).not.toThrow();
    });

    it("RegisterFileDefinition factory produces a RegisterFileElement", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("addrBits", 2);
      const el = RegisterFileDefinition.factory(props);
      expect(el.typeId).toBe("RegisterFile");
    });
  });

  describe("rendering", () => {
    it("draw() calls drawPolygon for body", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("addrBits", 2);
      const el = new RegisterFileElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.filter(c => c.method === "drawPolygon").length).toBeGreaterThanOrEqual(1);
    });

    it("draw() renders Din, we, Rw, C, Ra, Rb, Da, Db labels", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("addrBits", 2);
      const el = new RegisterFileElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      for (const lbl of ["Din", "we", "Rw", "C", "Ra", "Rb", "Da", "Db"]) {
        expect(texts).toContain(lbl);
      }
    });

    it("draw() renders component label when set", () => {
      const props = new PropertyBag();
      props.set("bitWidth", 8);
      props.set("addrBits", 2);
      props.set("label", "RF1");
      const el = new RegisterFileElement("id", { x: 0, y: 0 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter(c => c.method === "drawText").map(c => c.args[0]);
      expect(texts).toContain("RF1");
    });
  });
});
