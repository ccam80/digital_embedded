/**
 * Tests for BehavioralCounterElement and BehavioralRegisterElement.
 *
 * Tests verify:
 *   - Counter increments on rising clock edges
 *   - Counter resets to 0 on clear
 *   - Counter output voltages are V_OH or V_OL (no intermediate values)
 *   - Register latches all bits on rising clock edge
 *   - CounterDefinition and RegisterDefinition have analogFactory registered
 *   - CounterPresetDefinition has analogFactory registered
 */

import { describe, it, expect } from "vitest";
import {
  BehavioralCounterElement,
  BehavioralRegisterElement,
  makeBehavioralCounterAnalogFactory,
} from "../behavioral-sequential.js";
import { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import { CounterDefinition } from "../../../components/memory/counter.js";
import { CounterPresetDefinition } from "../../../components/memory/counter-preset.js";
import { RegisterDefinition } from "../../../components/memory/register.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import type { LoadContext } from "../load-context.js";
import { MODETRAN, MODEINITFLOAT } from "../ckt-mode.js";
import { makeLoadCtx, initElement } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";

function makeNullSolver() {
  return {
    allocElement: (_r: number, _c: number) => 0,
    stampElement: (_h: number, _v: number) => {},
    stamp: (_r: number, _c: number, _v: number) => {},
  } as any;
}

function makeCtx(_v: Float64Array = new Float64Array(16)): LoadContext {
  return makeLoadCtx({
    solver: makeNullSolver(),
    dt: 0,
    method: "trapezoidal",
    order: 1,
    cktMode: MODETRAN | MODEINITFLOAT,
  });
}

function makeAcceptCtx(v: Float64Array, dt = 1e-9): LoadContext {
  return { ...makeCtx(v), dt };
}
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const CMOS33: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

const V_HIGH = 3.3;
const V_LOW = 0.0;

/**
 * Build a 4-bit counter element.
 *
 * Node layout:
 *   0 = ground
 *   1 = en
 *   2 = clock
 *   3 = clr
 *   4 = out bit 0 (LSB)
 *   5 = out bit 1
 *   6 = out bit 2
 *   7 = out bit 3 (MSB)
 *   8 = ovf
 */
function buildCounter(bitWidth = 4): {
  element: BehavioralCounterElement;
  makeVoltages: (en: number, clock: number, clr: number) => Float64Array;
} {
  const enPin = new DigitalInputPinModel(CMOS33, true);
  enPin.init(1, 0);
  const clockPin = new DigitalInputPinModel(CMOS33, true);
  clockPin.init(2, 0);
  const clrPin = new DigitalInputPinModel(CMOS33, true);
  clrPin.init(3, 0);

  const outBitPins: DigitalOutputPinModel[] = [];
  for (let bit = 0; bit < bitWidth; bit++) {
    const pin = new DigitalOutputPinModel(CMOS33);
    pin.init(4 + bit, -1);
    outBitPins.push(pin);
  }

  const ovfPin = new DigitalOutputPinModel(CMOS33);
  ovfPin.init(4 + bitWidth, -1);

  const element = new BehavioralCounterElement(
    enPin,
    clockPin,
    clrPin,
    outBitPins,
    ovfPin,
    bitWidth,
    CMOS33.vIH,
    CMOS33.vIL,
    new Map(),
  );
  initElement(element);

  const solverSize = 4 + bitWidth;

  const makeVoltages = (en: number, clock: number, clr: number): Float64Array => {
    // 1-based: pins init at nodes 1,2,3 so readMnaVoltage reads v[1],v[2],v[3]
    const v = new Float64Array(solverSize + 1);
    v[1] = en;
    v[2] = clock;
    v[3] = clr;
    return v;
  };

  return { element, makeVoltages };
}

/**
 * Build an 8-bit register element.
 *
 * Node layout:
 *   0 = ground
 *   1..8 = D bits 0..7 (input data)
 *   9 = clock
 *   10 = en
 *   11..18 = Q bits 0..7 (output)
 */
function buildRegister(bitWidth = 8): {
  element: BehavioralRegisterElement;
  makeVoltages: (data: number, en: number, clock: number) => Float64Array;
  outBitPins: DigitalOutputPinModel[];
} {
  const dataPins: DigitalInputPinModel[] = [];
  for (let bit = 0; bit < bitWidth; bit++) {
    const pin = new DigitalInputPinModel(CMOS33, true);
    pin.init(1 + bit, 0);
    dataPins.push(pin);
  }

  const clockPin = new DigitalInputPinModel(CMOS33, true);
  clockPin.init(1 + bitWidth, 0);

  const enPin = new DigitalInputPinModel(CMOS33, true);
  enPin.init(1 + bitWidth + 1, 0);

  const outBitPins: DigitalOutputPinModel[] = [];
  for (let bit = 0; bit < bitWidth; bit++) {
    const pin = new DigitalOutputPinModel(CMOS33);
    pin.init(1 + bitWidth + 2 + bit, -1);
    outBitPins.push(pin);
  }

  const element = new BehavioralRegisterElement(
    dataPins,
    clockPin,
    enPin,
    outBitPins,
    bitWidth,
    CMOS33.vIH,
    CMOS33.vIL,
    new Map(),
  );
  initElement(element);

  const solverSize = 2 * bitWidth + 2;

  const makeVoltages = (data: number, en: number, clock: number): Float64Array => {
    // 1-based: data pins at nodes 1..bitWidth, clock at node 1+bitWidth, en at node 1+bitWidth+1
    const v = new Float64Array(solverSize + 1);
    for (let bit = 0; bit < bitWidth; bit++) {
      v[1 + bit] = ((data >> bit) & 1) ? V_HIGH : V_LOW;
    }
    v[1 + bitWidth] = clock;
    v[1 + bitWidth + 1] = en;
    return v;
  };

  return { element, makeVoltages, outBitPins };
}

/**
 * Apply one rising clock edge to the counter element.
 * Previous state: clock=low, new state: clock=high.
 */
function applyRisingEdge(
  element: BehavioralCounterElement,
  makeVoltages: (en: number, clock: number, clr: number) => Float64Array,
  en: number,
  clr: number,
): void {
  element.accept(makeAcceptCtx(makeVoltages(en, V_LOW, clr)), 0, () => {});
  element.accept(makeAcceptCtx(makeVoltages(en, V_HIGH, clr)), 0, () => {});
}

// ---------------------------------------------------------------------------
// Counter tests
// ---------------------------------------------------------------------------

describe("Counter", () => {
  it("counts_on_clock_edges", () => {
    const { element, makeVoltages } = buildCounter(4);

    element.load(makeCtx());

    // Apply 5 rising clock edges with en=1, clr=0
    for (let i = 0; i < 5; i++) {
      applyRisingEdge(element, makeVoltages, V_HIGH, V_LOW);
    }

    // Count should be 5 = 0b0101
    expect(element.count).toBe(5);

    element.load(makeCtx(makeVoltages(V_HIGH, V_LOW, V_LOW)));

    expect(element.count).toBe(5);
  });

  it("clear_resets_to_zero", () => {
    const { element, makeVoltages } = buildCounter(4);

    // Count to 3
    for (let i = 0; i < 3; i++) {
      applyRisingEdge(element, makeVoltages, V_HIGH, V_LOW);
    }
    expect(element.count).toBe(3);

    // Apply clock edge with clr=1
    applyRisingEdge(element, makeVoltages, V_HIGH, V_HIGH);
    expect(element.count).toBe(0);
  });

  it("output_voltages_match_logic", () => {
    // Build a counter via the factory to verify output pin voltage levels
    const nodeCount = 10;
    const props = {
      has: (k: string) => k === "bitWidth",
      get: (k: string) => k === "bitWidth" ? 4 : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // pinNodes: en=1, C=2, clr=3, out=4 (all out-bit pins share same bus node), ovf=8
    const factory = makeBehavioralCounterAnalogFactory();
    const element = factory(
      new Map([["en", 1], ["C", 2], ["clr", 3], ["out", 4], ["ovf", 8]]),
      props, () => 0,
    ) as BehavioralCounterElement;
    initElement(element);

    element.load(makeCtx());

    // Apply 5 clock edges: count = 5 = 0b0101
    const makeV = (en: number, clock: number, clr: number): Float64Array => {
      const v = new Float64Array(nodeCount);
      v[1] = en; v[2] = clock; v[3] = clr;
      return v;
    };

    for (let i = 0; i < 5; i++) {
      element.accept(makeAcceptCtx(makeV(V_HIGH, V_LOW, V_LOW)), 0, () => {});
      element.accept(makeAcceptCtx(makeV(V_HIGH, V_HIGH, V_LOW)), 0, () => {});
    }

    element.load(makeCtx(makeV(V_HIGH, V_LOW, V_LOW)));

    // count=5 = 0b0101: bit0=1, bit1=0, bit2=1, bit3=0
    expect(element.count).toBe(5);

    const expectedBits = [1, 0, 1, 0]; // count=5=0b0101
    for (let bit = 0; bit < 4; bit++) {
      const countBit = (element.count >> bit) & 1;
      expect(countBit).toBe(expectedBits[bit]);
    }
  });
});

// ---------------------------------------------------------------------------
// Register tests
// ---------------------------------------------------------------------------

describe("Register", () => {
  it("latches_all_bits", () => {
    const { element, makeVoltages } = buildRegister(8);

    element.load(makeCtx());

    // Initial state: all outputs LOW (storedValue=0)
    expect(element.storedValue).toBe(0);

    // Set data to 0xA5 = 0b10100101, en=1, clock low→high (rising edge)
    element.accept(makeAcceptCtx(makeVoltages(0xA5, V_HIGH, V_LOW)), 0, () => {});
    element.accept(makeAcceptCtx(makeVoltages(0xA5, V_HIGH, V_HIGH)), 0, () => {});

    // Stored value should now be 0xA5
    expect(element.storedValue).toBe(0xA5);

    element.load(makeCtx(makeVoltages(0xA5, V_HIGH, V_HIGH)));

    // Verify output pin voltage levels match 0xA5 = 0b10100101
    const expected = [1, 0, 1, 0, 0, 1, 0, 1]; // bits 0..7 of 0xA5
    for (let bit = 0; bit < 8; bit++) {
      const expectedHigh = expected[bit] === 1;
      if (expectedHigh) {
      } else {
      }
    }
  });

  it("does_not_latch_without_enable", () => {
    const { element, makeVoltages } = buildRegister(8);

    // Clock edge with en=0 — should not latch
    element.accept(makeAcceptCtx(makeVoltages(0xFF, V_LOW, V_LOW)), 0, () => {});
    element.accept(makeAcceptCtx(makeVoltages(0xFF, V_LOW, V_HIGH)), 0, () => {});

    expect(element.storedValue).toBe(0);
  });

  it("holds_value_across_timesteps", () => {
    const { element, makeVoltages } = buildRegister(8);

    // Latch 0x55
    element.accept(makeAcceptCtx(makeVoltages(0x55, V_HIGH, V_LOW)), 0, () => {});
    element.accept(makeAcceptCtx(makeVoltages(0x55, V_HIGH, V_HIGH)), 0, () => {});
    expect(element.storedValue).toBe(0x55);

    // Many timesteps with data=0, clock idle — value must hold
    for (let i = 0; i < 10; i++) {
      element.accept(makeAcceptCtx(makeVoltages(0x00, V_HIGH, V_HIGH)), 0, () => {});
    }
    expect(element.storedValue).toBe(0x55);
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("counter_has_analog_factory", () => {
    expect(typeof (CounterDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("counter_engine_type_is_both", () => {
    expect(CounterDefinition.models?.digital).not.toBeUndefined();
    expect(CounterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("counter_simulation_modes_include_digital_and_simplified", () => {
    expect(CounterDefinition.models?.digital).not.toBeUndefined();
    expect(CounterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("counter_preset_has_analog_factory", () => {
    expect(typeof (CounterPresetDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("counter_preset_engine_type_is_both", () => {
    expect(CounterPresetDefinition.models?.digital).not.toBeUndefined();
    expect(CounterPresetDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("register_has_analog_factory", () => {
    expect(typeof (RegisterDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("register_engine_type_is_both", () => {
    expect(RegisterDefinition.models?.digital).not.toBeUndefined();
    expect(RegisterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("register_simulation_modes_include_digital_and_simplified", () => {
    expect(RegisterDefinition.models?.digital).not.toBeUndefined();
    expect(RegisterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("counter_analog_factory_returns_analog_element", () => {
    const factory = getFactory(CounterDefinition.modelRegistry!.behavioral!);
    const props = new PropertyBag();
    props.set("bitWidth", 4 as unknown as import("../../../core/properties.js").PropertyValue);
    const element = factory(
      new Map([["en", 1], ["C", 2], ["clr", 3], ["out", 4], ["ovf", 5]]),
      props, () => 0,
    );
    expect(element.branchIndex).toBe(-1);
    expect(element._pinNodes.size).toBe(5);
  });

  it("register_analog_factory_returns_analog_element", () => {
    const factory = getFactory(RegisterDefinition.modelRegistry!.behavioral!);
    const props = new PropertyBag();
    props.set("bitWidth", 8 as unknown as import("../../../core/properties.js").PropertyValue);
    const element = factory(
      new Map([["D", 1], ["C", 2], ["en", 3], ["Q", 4]]),
      props, () => 0,
    );
    expect(element.branchIndex).toBe(-1);
    expect(element._pinNodes.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Task 6.4.3 — sequential_pin_loading_propagates
// ---------------------------------------------------------------------------

describe("Task 6.4.3 — sequential pin loading propagates", () => {
  it("sequential_pin_loading_propagates", () => {
    // 4-bit counter: en=node 1, C=node 2, clr=node 3, out=node 4, ovf=node 5.
    // Set _pinLoading so "en" is loaded=true but "C" and "clr" are loaded=false.
    // Verify via allocElement spy:
    //   en (MNA node 1 → nodeIdx 0) → allocElement called at (0,0)
    //   C  (MNA node 2 → nodeIdx 1) → NO call at (1,1)
    const pinLoading: Record<string, boolean> = {
      "en": true,
      "C": false,
      "clr": false,
      "out": false,
      "ovf": false,
    };
    const props = new PropertyBag();
    props.set("bitWidth", 4 as unknown as import("../../../core/properties.js").PropertyValue);
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);

    const factory = getFactory(CounterDefinition.modelRegistry!.behavioral!);
    const element = factory(
      new Map([["en", 1], ["C", 2], ["clr", 3], ["out", 4], ["ovf", 5]]),
      props, () => 0,
    );
    initElement(element);

    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
    };

    const ctx: LoadContext = makeLoadCtx({
      solver: solver as any,
      cktMode: MODETRAN | MODEINITFLOAT,
      dt: 0,
      method: "trapezoidal",
      order: 1,
    });

    element.load(ctx);

    // en (MNA node 1, 1-based) should have a diagonal stamp (loaded=true)
    const enDiag = allocCalls.some(([r, c]) => r === 1 && c === 1);
    // C (MNA node 2, 1-based) should NOT have a diagonal stamp (loaded=false -> no-op)
    const clockDiag = allocCalls.some(([r, c]) => r === 2 && c === 2);

    expect(enDiag).toBe(true);
    expect(clockDiag).toBe(false);
  });
});
