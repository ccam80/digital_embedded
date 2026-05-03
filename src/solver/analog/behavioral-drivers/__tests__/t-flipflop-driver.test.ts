/**
 * Unit tests for BehavioralTFlipflopDriverElement load() semantics.
 *
 * Drives load() directly with a minimal mock LoadContext + StatePoolRef so
 * the toggle / hold / edge-detection / forceToggle paths are isolated from
 * the rest of the analog pipeline. State-pool slot semantics (s1=last
 * accepted, s0=current step) are simulated by promoting s0 → s1 between
 * "accepted" steps.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  BehavioralTFlipflopDriverElement,
  BehavioralTFlipflopDriverDefinition,
} from "../t-flipflop-driver.js";
import { PropertyBag } from "../../../../core/properties.js";
import type { LoadContext } from "../../load-context.js";
import type { StatePoolRef } from "../../state-pool.js";

// ---------------------------------------------------------------------------
// Pin / node assignment- driver-local toy MNA layout
// ---------------------------------------------------------------------------
//
// Node 0 is GND (ngspice convention). The driver reads (T - gnd), (C - gnd).
// Pinning gnd to a non-zero node verifies the driver's gnd-relative read is
// correct, not just collapsing to a hard zero.

const NODE_GND = 1;
const NODE_T   = 2;
const NODE_C   = 3;
const NODE_Q   = 4;
const NODE_NQ  = 5;
const NODE_COUNT = 6;

function makePinNodes(): Map<string, number> {
  return new Map<string, number>([
    ["gnd", NODE_GND],
    ["T",   NODE_T],
    ["C",   NODE_C],
    ["Q",   NODE_Q],
    ["~Q",  NODE_NQ],
  ]);
}

// ---------------------------------------------------------------------------
// Minimal pool / context mocks- only the surface load() touches.
// ---------------------------------------------------------------------------

interface MockPool {
  pool: StatePoolRef;
  promote(): void;
}

function makePool(stateSize: number): MockPool {
  const s0 = new Float64Array(stateSize);
  const s1 = new Float64Array(stateSize);
  const states: Float64Array[] = [s0, s1];
  const pool = {
    states,
    state0: s0,
    state1: s1,
    state2: new Float64Array(stateSize),
    state3: new Float64Array(stateSize),
    state4: new Float64Array(stateSize),
    state5: new Float64Array(stateSize),
    state6: new Float64Array(stateSize),
    state7: new Float64Array(stateSize),
    totalSlots: stateSize,
    tranStep: 0,
  } as unknown as StatePoolRef;

  return {
    pool,
    promote() {
      // Simulate engine's accept-step rotation: s1 (last accepted) ← s0
      // (current). The driver writes to s0 in load(); after promotion the
      // next load() reads its own previous writes via s1.
      for (let i = 0; i < stateSize; i++) s1[i] = s0[i];
    },
  };
}

function makeCtx(rhsOld: Float64Array): LoadContext {
  return { rhsOld } as unknown as LoadContext;
}

function setVoltages(rhs: Float64Array, vT: number, vClock: number): void {
  rhs[NODE_GND] = 0;
  rhs[NODE_T]   = vT;
  rhs[NODE_C]   = vClock;
}

// ---------------------------------------------------------------------------
// Driver factory- bypass setup() because the test drives load() directly.
// ---------------------------------------------------------------------------

function makeDriver(opts: { forceToggle?: 0 | 1; vIH?: number; vIL?: number } = {}) {
  const props = new PropertyBag();
  props.setModelParam("vIH", opts.vIH ?? 2.0);
  props.setModelParam("vIL", opts.vIL ?? 0.8);
  if (opts.forceToggle !== undefined) {
    props.setModelParam("forceToggle", opts.forceToggle);
  }
  const drv = new BehavioralTFlipflopDriverElement(makePinNodes(), props);
  drv._stateBase = 0;
  const mockPool = makePool(drv.stateSize);
  drv.initState(mockPool.pool);
  return { drv, mockPool };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BehavioralTFlipflopDriverElement.load", () => {
  let rhs: Float64Array;
  beforeEach(() => {
    rhs = new Float64Array(NODE_COUNT);
  });

  describe("withEnable=true (forceToggle=0, default)", () => {
    it("holds Q on first sample even if clock starts high (_firstSample skip)", () => {
      const { drv, mockPool } = makeDriver();
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      // No edge detected on first sample → Q stays at initial 0.
      expect(mockPool.pool.states[0][1]).toBe(0); // SLOT_Q
      expect(mockPool.pool.states[0][2]).toBe(0); // SLOT_OUT_Q
      expect(mockPool.pool.states[0][3]).toBe(1); // SLOT_OUT_NQ
    });

    it("toggles Q on rising clock edge when T is high", () => {
      const { drv, mockPool } = makeDriver();
      // Step 1: clock low, T high. Establish baseline (no edge).
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 0);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      // Step 2: clock rises with T still high → toggle Q from 0 to 1.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(1); // SLOT_Q
      expect(mockPool.pool.states[0][2]).toBe(1); // SLOT_OUT_Q
      expect(mockPool.pool.states[0][3]).toBe(0); // SLOT_OUT_NQ
    });

    it("toggles back on the next rising edge with T high", () => {
      const { drv, mockPool } = makeDriver();
      // Step 1: clock low, T high.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 0);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      // Step 2: rising edge → Q = 1.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      // Step 3: clock falls (no edge) → hold.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 0);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(1);
      mockPool.promote();
      // Step 4: rising edge again → Q toggles back to 0.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(0);
    });

    it("holds Q on rising edge when T is low", () => {
      const { drv, mockPool } = makeDriver();
      // Pre-load Q=1 by toggling once.
      setVoltages(rhs, 5, 0); drv.load(makeCtx(rhs)); mockPool.promote();
      setVoltages(rhs, 5, 5); drv.load(makeCtx(rhs)); mockPool.promote();
      expect(mockPool.pool.states[1][1]).toBe(1);
      // Now drop T low and pulse the clock- Q should hold.
      setVoltages(rhs, /*vT*/ 0, /*vClock*/ 0);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      setVoltages(rhs, /*vT*/ 0, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(1); // held
    });

    it("holds Q on rising edge when T is indeterminate (between vIL and vIH)", () => {
      const { drv, mockPool } = makeDriver({ vIH: 2.0, vIL: 0.8 });
      // Establish baseline at clock low.
      setVoltages(rhs, /*vT*/ 1.5, /*vClock*/ 0);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      // Rising edge with T in the indeterminate band [0.8, 2.0).
      setVoltages(rhs, /*vT*/ 1.5, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(0); // initial 0, held
    });

    it("does not toggle on falling clock edge", () => {
      const { drv, mockPool } = makeDriver();
      // Clock starts high (no edge on first sample due to _firstSample guard).
      setVoltages(rhs, 5, 5);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      // Clock falls.
      setVoltages(rhs, 5, 0);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(0); // no toggle
    });

    it("respects vIH threshold for clock edge detection", () => {
      const { drv, mockPool } = makeDriver({ vIH: 3.0, vIL: 0.8 });
      // Clock at 2.5 < vIH=3.0 is "low" for edge detection.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 2.5);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      // Step 2: clock to 2.9 (still below vIH=3.0)- no edge.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 2.9);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(0);
      mockPool.promote();
      // Step 3: clock crosses vIH → toggle.
      setVoltages(rhs, /*vT*/ 5, /*vClock*/ 3.0);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(1);
    });

    it("reads voltages relative to gnd node, not absolute", () => {
      const { drv, mockPool } = makeDriver();
      // Lift gnd reference to 2V; T at 7V (delta 5V → high), clock at 2V
      // (delta 0 → low).
      rhs[NODE_GND] = 2;
      rhs[NODE_T]   = 7;
      rhs[NODE_C]   = 2;
      drv.load(makeCtx(rhs));
      mockPool.promote();
      // Rising edge: clock goes to 7V (delta 5V → high), T still high.
      rhs[NODE_C] = 7;
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(1); // toggled
    });
  });

  describe("withEnable=false (forceToggle=1)", () => {
    it("toggles unconditionally on rising clock edge regardless of T", () => {
      const { drv, mockPool } = makeDriver({ forceToggle: 1 });
      // T held LOW so any T-gated path would hold; forceToggle must override.
      setVoltages(rhs, /*vT*/ 0, /*vClock*/ 0);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      setVoltages(rhs, /*vT*/ 0, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(1);
      mockPool.promote();
      setVoltages(rhs, /*vT*/ 0, /*vClock*/ 0);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      setVoltages(rhs, /*vT*/ 0, /*vClock*/ 5);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(0); // toggled back
    });

    it("still respects rising-edge detection (no toggle without edge)", () => {
      const { drv, mockPool } = makeDriver({ forceToggle: 1 });
      // Hold clock high across two steps- no edge after the first sample.
      setVoltages(rhs, 0, 5);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      setVoltages(rhs, 0, 5);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(0);
    });
  });

  describe("setParam", () => {
    it("hot-loads vIH and vIL", () => {
      const { drv, mockPool } = makeDriver({ vIH: 2.0, vIL: 0.8 });
      drv.setParam("vIH", 4.0);
      drv.setParam("vIL", 1.0);
      // Clock at 3V was a rising edge under vIH=2.0; under vIH=4.0 it is
      // sub-threshold and produces no edge.
      setVoltages(rhs, 5, 0);
      drv.load(makeCtx(rhs));
      mockPool.promote();
      setVoltages(rhs, 5, 3);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(0); // no edge under new vIH
      mockPool.promote();
      setVoltages(rhs, 5, 4);
      drv.load(makeCtx(rhs));
      expect(mockPool.pool.states[0][1]).toBe(1); // crosses 4.0 → toggle
    });
  });

  describe("getPinCurrents", () => {
    it("returns all-zero array sized to pin count (driver injects no current)", () => {
      const { drv } = makeDriver();
      const currents = drv.getPinCurrents(new Float64Array(NODE_COUNT));
      expect(currents).toHaveLength(5);
      expect(currents.every((c) => c === 0)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Definition / registration sanity
// ---------------------------------------------------------------------------

describe("BehavioralTFlipflopDriverDefinition", () => {
  it("is internal-only with the canonical default model", () => {
    expect(BehavioralTFlipflopDriverDefinition.internalOnly).toBe(true);
    expect(BehavioralTFlipflopDriverDefinition.modelRegistry?.default).toBeDefined();
    expect(BehavioralTFlipflopDriverDefinition.defaultModel).toBe("default");
  });

  it("declares vIH, vIL, and forceToggle paramDefs", () => {
    const model = BehavioralTFlipflopDriverDefinition.modelRegistry!.default!;
    expect(model.kind).toBe("inline");
    const inline = model as { kind: "inline"; paramDefs: { key: string }[] };
    const keys = inline.paramDefs.map((p) => p.key).sort();
    expect(keys).toEqual(["forceToggle", "vIH", "vIL"]);
  });

  it("exposes T, C, Q, ~Q, gnd pins in that order", () => {
    expect(BehavioralTFlipflopDriverDefinition.pinLayout!.map((p) => p.label))
      .toEqual(["T", "C", "Q", "~Q", "gnd"]);
  });
});
