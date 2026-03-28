/**
 * Tests for RotEncoder and StepperMotor components.
 *
 * Covers:
 *   - Rotary encoder quadrature output sequence
 *   - Stepper motor step sequence detection (bipolar and unipolar)
 *   - Direction control (CW vs CCW position)
 *   - Pin layout
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  RotaryEncoderElement,
  executeRotaryEncoder,
  RotaryEncoderDefinition,
  ROTARY_ENCODER_ATTRIBUTE_MAPPINGS,
  QUADRATURE_TABLE,
} from "../rotary-encoder.js";
import {
  StepperMotorBipolarElement,
  StepperMotorUnipolarElement,
  executeStepperMotorBipolar,
  executeStepperMotorUnipolar,
  StepperMotorBipolarDefinition,
  StepperMotorUnipolarDefinition,
  STEPPER_MOTOR_ATTRIBUTE_MAPPINGS,
  BIPOLAR_STEP_SEQUENCE,
  UNIPOLAR_STEP_SEQUENCE,
} from "../stepper-motor.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number = 1): ComponentLayout {
  const wt = new Int32Array(64).map((_, i) => i);
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
    wiringTable: wt,
    getProperty: () => undefined,
  };
}

function makeState(inputs: number[], extraSlots: number = 3): Uint32Array {
  const arr = new Uint32Array(inputs.length + extraSlots);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
  return arr;
}

interface DrawCall {
  method: string;
  args: unknown[];
}

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

function makeRotaryEncoder(overrides?: { label?: string }): RotaryEncoderElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  return new RotaryEncoderElement("test-enc-001", { x: 0, y: 0 }, 0, false, props);
}

function makeBipolarMotor(overrides?: { label?: string }): StepperMotorBipolarElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  return new StepperMotorBipolarElement("test-bipolar-001", { x: 0, y: 0 }, 0, false, props);
}

function makeUnipolarMotor(overrides?: { label?: string }): StepperMotorUnipolarElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  return new StepperMotorUnipolarElement("test-unipolar-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// RotaryEncoder tests
// ---------------------------------------------------------------------------

describe("RotaryEncoder", () => {
  describe("quadratureOutput", () => {
    it("QUADRATURE_TABLE has 4 entries", () => {
      expect(QUADRATURE_TABLE.length).toBe(4);
    });

    it("position 0: A=0, B=0", () => {
      const layout = makeLayout(0, 3);
      const state = makeState([], 3);
      const highZs = new Uint32Array(state.length);
      state[2] = 0; // position = 0
      executeRotaryEncoder(0, state, highZs, layout);
      expect(state[0]).toBe(0); // A
      expect(state[1]).toBe(0); // B
    });

    it("position 1: A=1, B=0", () => {
      const layout = makeLayout(0, 3);
      const state = makeState([], 3);
      const highZs = new Uint32Array(state.length);
      state[2] = 1; // position = 1
      executeRotaryEncoder(0, state, highZs, layout);
      expect(state[0]).toBe(1); // A
      expect(state[1]).toBe(0); // B
    });

    it("position 2: A=1, B=1", () => {
      const layout = makeLayout(0, 3);
      const state = makeState([], 3);
      const highZs = new Uint32Array(state.length);
      state[2] = 2;
      executeRotaryEncoder(0, state, highZs, layout);
      expect(state[0]).toBe(1); // A
      expect(state[1]).toBe(1); // B
    });

    it("position 3: A=0, B=1", () => {
      const layout = makeLayout(0, 3);
      const state = makeState([], 3);
      const highZs = new Uint32Array(state.length);
      state[2] = 3;
      executeRotaryEncoder(0, state, highZs, layout);
      expect(state[0]).toBe(0); // A
      expect(state[1]).toBe(1); // B
    });

    it("position wraps via mask (position 4 → same as 0)", () => {
      const layout = makeLayout(0, 3);
      const state = makeState([], 3);
      const highZs = new Uint32Array(state.length);
      state[2] = 4; // 4 & 3 = 0
      executeRotaryEncoder(0, state, highZs, layout);
      expect(state[0]).toBe(QUADRATURE_TABLE[0][0]);
      expect(state[1]).toBe(QUADRATURE_TABLE[0][1]);
    });

    it("quadrature sequence is a valid Gray code (adjacent values differ by 1 bit)", () => {
      for (let i = 0; i < 4; i++) {
        const curr = (QUADRATURE_TABLE[i][0] << 1) | QUADRATURE_TABLE[i][1];
        const next = (QUADRATURE_TABLE[(i + 1) % 4][0] << 1) | QUADRATURE_TABLE[(i + 1) % 4][1];
        const diff = curr ^ next;
        // Exactly 1 bit should differ between adjacent positions
        expect(diff & (diff - 1)).toBe(0);
        expect(diff).not.toBe(0);
      }
    });
  });

  describe("pinLayout", () => {
    it("RotaryEncoder has 2 output pins A and B", () => {
      const el = makeRotaryEncoder();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(2);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain("A");
      expect(labels).toContain("B");
    });

    it("RotaryEncoder has no input pins", () => {
      const el = makeRotaryEncoder();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(0);
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeRotaryEncoder();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders knob circle", () => {
      const el = makeRotaryEncoder();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders label when set", () => {
      const el = makeRotaryEncoder({ label: "ENC1" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "ENC1")).toBe(true);
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = ROTARY_ENCODER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("ENC1")).toBe("ENC1");
    });
  });

  describe("definitionComplete", () => {
    it("RotaryEncoderDefinition has name='RotEncoder'", () => {
      expect(RotaryEncoderDefinition.name).toBe("RotEncoder");
    });

    it("RotaryEncoderDefinition has typeId=-1", () => {
      expect(RotaryEncoderDefinition.typeId).toBe(-1);
    });

    it("RotaryEncoderDefinition factory produces RotaryEncoderElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      const el = RotaryEncoderDefinition.factory(props);
      expect(el.typeId).toBe("RotEncoder");
    });

    it("RotaryEncoderDefinition executeFn is executeRotaryEncoder", () => {
      expect(RotaryEncoderDefinition.models!.digital!.executeFn).toBe(executeRotaryEncoder);
    });

    it("RotaryEncoderDefinition category is IO", () => {
      expect(RotaryEncoderDefinition.category).toBe(ComponentCategory.IO);
    });

    it("RotaryEncoderDefinition has non-empty helpText", () => {
      expect(typeof RotaryEncoderDefinition.helpText).toBe("string"); expect(RotaryEncoderDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("RotaryEncoderDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(RotaryEncoderDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// StepperMotorBipolar tests
// ---------------------------------------------------------------------------

describe("StepperMotorBipolar", () => {
  describe("stepSequence", () => {
    it("BIPOLAR_STEP_SEQUENCE has 4 entries", () => {
      expect(BIPOLAR_STEP_SEQUENCE.length).toBe(4);
    });

    it("step 0 pattern: A+=1, A-=0, B+=1, B-=0 → S0=0, S1=0", () => {
      const layout = makeLayout(4, 2);
      const state = makeState([1, 0, 1, 0], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorBipolar(0, state, highZs, layout);
      expect(state[4]).toBe(0); // S0 = stepIndex & 0x3 = 0
      expect(state[5]).toBe(0); // S1 = (stepIndex >> 2) & 0x3 = 0
    });

    it("step 1 pattern: A+=0, A-=1, B+=1, B-=0 → S0=1, S1=0", () => {
      const layout = makeLayout(4, 2);
      const state = makeState([0, 1, 1, 0], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorBipolar(0, state, highZs, layout);
      expect(state[4]).toBe(1); // S0 = 1 & 0x3
      expect(state[5]).toBe(0); // S1 = 0
    });

    it("step 2 pattern: A+=0, A-=1, B+=0, B-=1 → S0=2, S1=0", () => {
      const layout = makeLayout(4, 2);
      const state = makeState([0, 1, 0, 1], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorBipolar(0, state, highZs, layout);
      expect(state[4]).toBe(2); // S0 = 2 & 0x3
      expect(state[5]).toBe(0); // S1 = 0
    });

    it("step 3 pattern: A+=1, A-=0, B+=0, B-=1 → S0=3, S1=0", () => {
      const layout = makeLayout(4, 2);
      const state = makeState([1, 0, 0, 1], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorBipolar(0, state, highZs, layout);
      expect(state[4]).toBe(3); // S0 = 3 & 0x3
      expect(state[5]).toBe(0); // S1 = 0
    });
  });

  describe("pinLayout", () => {
    it("bipolar motor has 4 input pins", () => {
      const el = makeBipolarMotor();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(4);
    });

    it("bipolar motor input labels include A+ and B-", () => {
      const el = makeBipolarMotor();
      const labels = el.getPins()
        .filter((p) => p.direction === PinDirection.INPUT)
        .map((p) => p.label);
      expect(labels).toContain("A+");
      expect(labels).toContain("B-");
    });

    it("bipolar motor has 2 output pins S0 and S1", () => {
      const el = makeBipolarMotor();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(2);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain("S0");
      expect(labels).toContain("S1");
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeBipolarMotor();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders motor circle", () => {
      const el = makeBipolarMotor();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circles = calls.filter((c) => c.method === "drawCircle");
      expect(circles.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders motor circle and pointer line", () => {
      const el = makeBipolarMotor();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const circles = calls.filter((c) => c.method === "drawCircle");
      const lines = calls.filter((c) => c.method === "drawLine");
      // circle at (0.5,1) r=2 and vertical pointer line
      expect(circles.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("definitionComplete", () => {
    it("StepperMotorBipolarDefinition has name='StepperMotorBipolar'", () => {
      expect(StepperMotorBipolarDefinition.name).toBe("StepperMotorBipolar");
    });

    it("StepperMotorBipolarDefinition has typeId=-1", () => {
      expect(StepperMotorBipolarDefinition.typeId).toBe(-1);
    });

    it("StepperMotorBipolarDefinition factory produces StepperMotorBipolarElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      const el = StepperMotorBipolarDefinition.factory(props);
      expect(el.typeId).toBe("StepperMotorBipolar");
    });

    it("StepperMotorBipolarDefinition executeFn is executeStepperMotorBipolar", () => {
      expect(StepperMotorBipolarDefinition.models!.digital!.executeFn).toBe(executeStepperMotorBipolar);
    });

    it("StepperMotorBipolarDefinition category is IO", () => {
      expect(StepperMotorBipolarDefinition.category).toBe(ComponentCategory.IO);
    });

    it("StepperMotorBipolarDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(StepperMotorBipolarDefinition)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// StepperMotorUnipolar tests
// ---------------------------------------------------------------------------

describe("StepperMotorUnipolar", () => {
  describe("stepSequence", () => {
    it("UNIPOLAR_STEP_SEQUENCE has 4 entries", () => {
      expect(UNIPOLAR_STEP_SEQUENCE.length).toBe(4);
    });

    it("step 0: P0=1,P1=0,P2=0,P3=0,com=0 → S0=0, S1=0", () => {
      const layout = makeLayout(5, 2);
      const state = makeState([1, 0, 0, 0, 0], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorUnipolar(0, state, highZs, layout);
      expect(state[5]).toBe(0); // S0
      expect(state[6]).toBe(0); // S1
    });

    it("step 1: P0=0,P1=1,P2=0,P3=0,com=0 → S0=1, S1=0", () => {
      const layout = makeLayout(5, 2);
      const state = makeState([0, 1, 0, 0, 0], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorUnipolar(0, state, highZs, layout);
      expect(state[5]).toBe(1); // S0
      expect(state[6]).toBe(0); // S1
    });

    it("step 2: P0=0,P1=0,P2=1,P3=0,com=0 → S0=2, S1=0", () => {
      const layout = makeLayout(5, 2);
      const state = makeState([0, 0, 1, 0, 0], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorUnipolar(0, state, highZs, layout);
      expect(state[5]).toBe(2); // S0
      expect(state[6]).toBe(0); // S1
    });

    it("step 3: P0=0,P1=0,P2=0,P3=1,com=0 → S0=3, S1=0", () => {
      const layout = makeLayout(5, 2);
      const state = makeState([0, 0, 0, 1, 0], 2);
      const highZs = new Uint32Array(state.length);
      executeStepperMotorUnipolar(0, state, highZs, layout);
      expect(state[5]).toBe(3); // S0
      expect(state[6]).toBe(0); // S1
    });
  });

  describe("pinLayout", () => {
    it("unipolar motor has 5 input pins", () => {
      const el = makeUnipolarMotor();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(5);
    });

    it("unipolar motor input labels include P0, P3, and com", () => {
      const el = makeUnipolarMotor();
      const labels = el.getPins()
        .filter((p) => p.direction === PinDirection.INPUT)
        .map((p) => p.label);
      expect(labels).toContain("P0");
      expect(labels).toContain("P3");
      expect(labels).toContain("com");
    });

    it("unipolar motor has 2 output pins S0 and S1", () => {
      const el = makeUnipolarMotor();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(2);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain("S0");
      expect(labels).toContain("S1");
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = STEPPER_MOTOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.convert("M1")).toBe("M1");
    });
  });

  describe("definitionComplete", () => {
    it("StepperMotorUnipolarDefinition has name='StepperMotorUnipolar'", () => {
      expect(StepperMotorUnipolarDefinition.name).toBe("StepperMotorUnipolar");
    });

    it("StepperMotorUnipolarDefinition has typeId=-1", () => {
      expect(StepperMotorUnipolarDefinition.typeId).toBe(-1);
    });

    it("StepperMotorUnipolarDefinition factory produces StepperMotorUnipolarElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      const el = StepperMotorUnipolarDefinition.factory(props);
      expect(el.typeId).toBe("StepperMotorUnipolar");
    });

    it("StepperMotorUnipolarDefinition executeFn is executeStepperMotorUnipolar", () => {
      expect(StepperMotorUnipolarDefinition.models!.digital!.executeFn).toBe(executeStepperMotorUnipolar);
    });

    it("StepperMotorUnipolarDefinition category is IO", () => {
      expect(StepperMotorUnipolarDefinition.category).toBe(ComponentCategory.IO);
    });

    it("StepperMotorUnipolarDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(StepperMotorUnipolarDefinition)).not.toThrow();
    });

  });
});
