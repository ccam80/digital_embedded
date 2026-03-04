/**
 * Unit tests for engine-interface.ts types and the MockEngine implementation.
 *
 * Verifies:
 *  - SimulationEngine interface is fully implemented by MockEngine
 *  - EngineState values are correct
 *  - EngineMessage discriminated union covers all required command types
 *  - EngineResponse discriminated union covers all reply types
 *  - MockEngine state transitions are valid
 *  - Signal access via getSignalRaw/getSignalValue/setSignalValue round-trips correctly
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockEngine } from "@/test-utils/mock-engine";
import { BitVector } from "@/core/signal";
import type {
  SimulationEngine,
  CompiledCircuit,
  EngineState,
  EngineChangeListener,
  EngineMessage,
  EngineResponse,
} from "@/core/engine-interface";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCUIT: CompiledCircuit = { netCount: 16, componentCount: 4 };

function freshEngine(): MockEngine {
  const engine = new MockEngine();
  engine.init(CIRCUIT);
  return engine;
}

// ---------------------------------------------------------------------------
// Type-level checks — confirm SimulationEngine interface is fully covered
// ---------------------------------------------------------------------------

describe("SimulationEngine interface compliance", () => {
  it("MockEngine satisfies SimulationEngine at the type level", () => {
    const engine: SimulationEngine = new MockEngine();
    expect(engine).toBeDefined();
  });

  it("all required methods exist on MockEngine", () => {
    const engine = new MockEngine();
    expect(typeof engine.init).toBe("function");
    expect(typeof engine.reset).toBe("function");
    expect(typeof engine.dispose).toBe("function");
    expect(typeof engine.step).toBe("function");
    expect(typeof engine.microStep).toBe("function");
    expect(typeof engine.runToBreak).toBe("function");
    expect(typeof engine.start).toBe("function");
    expect(typeof engine.stop).toBe("function");
    expect(typeof engine.getState).toBe("function");
    expect(typeof engine.getSignalRaw).toBe("function");
    expect(typeof engine.getSignalValue).toBe("function");
    expect(typeof engine.setSignalValue).toBe("function");
    expect(typeof engine.addChangeListener).toBe("function");
    expect(typeof engine.removeChangeListener).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// EngineState values
// ---------------------------------------------------------------------------

describe("EngineState", () => {
  it("has all four required values", () => {
    const states: EngineState[] = ["STOPPED", "RUNNING", "PAUSED", "ERROR"];
    expect(states).toHaveLength(4);
    expect(states).toContain("STOPPED");
    expect(states).toContain("RUNNING");
    expect(states).toContain("PAUSED");
    expect(states).toContain("ERROR");
  });
});

// ---------------------------------------------------------------------------
// EngineMessage discriminated union
// ---------------------------------------------------------------------------

describe("EngineMessage discriminated union", () => {
  it("covers step command", () => {
    const msg: EngineMessage = { type: "step" };
    expect(msg.type).toBe("step");
  });

  it("covers microStep command", () => {
    const msg: EngineMessage = { type: "microStep" };
    expect(msg.type).toBe("microStep");
  });

  it("covers runToBreak command", () => {
    const msg: EngineMessage = { type: "runToBreak" };
    expect(msg.type).toBe("runToBreak");
  });

  it("covers start command", () => {
    const msg: EngineMessage = { type: "start" };
    expect(msg.type).toBe("start");
  });

  it("covers stop command", () => {
    const msg: EngineMessage = { type: "stop" };
    expect(msg.type).toBe("stop");
  });

  it("covers reset command", () => {
    const msg: EngineMessage = { type: "reset" };
    expect(msg.type).toBe("reset");
  });

  it("covers dispose command", () => {
    const msg: EngineMessage = { type: "dispose" };
    expect(msg.type).toBe("dispose");
  });

  it("covers setSignal command with all required fields", () => {
    const msg: EngineMessage = {
      type: "setSignal",
      netId: 3,
      valueLo: 0xff,
      valueHi: 0,
      highZLo: 0,
      highZHi: 0,
      width: 8,
    };
    expect(msg.type).toBe("setSignal");
    if (msg.type === "setSignal") {
      expect(msg.netId).toBe(3);
      expect(msg.valueLo).toBe(0xff);
      expect(msg.valueHi).toBe(0);
      expect(msg.highZLo).toBe(0);
      expect(msg.highZHi).toBe(0);
      expect(msg.width).toBe(8);
    }
  });
});

// ---------------------------------------------------------------------------
// EngineResponse discriminated union
// ---------------------------------------------------------------------------

describe("EngineResponse discriminated union", () => {
  it("covers stateChange response", () => {
    const resp: EngineResponse = { type: "stateChange", state: "RUNNING" };
    expect(resp.type).toBe("stateChange");
    if (resp.type === "stateChange") {
      expect(resp.state).toBe("RUNNING");
    }
  });

  it("covers error response", () => {
    const resp: EngineResponse = { type: "error", message: "short circuit" };
    expect(resp.type).toBe("error");
    if (resp.type === "error") {
      expect(resp.message).toBe("short circuit");
    }
  });

  it("covers breakpoint response", () => {
    const resp: EngineResponse = { type: "breakpoint" };
    expect(resp.type).toBe("breakpoint");
  });
});

// ---------------------------------------------------------------------------
// MockEngine lifecycle and state transitions
// ---------------------------------------------------------------------------

describe("MockEngine lifecycle", () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = new MockEngine();
  });

  it("starts in STOPPED state before init", () => {
    expect(engine.getState()).toBe("STOPPED");
  });

  it("init sets state to STOPPED and allocates signals", () => {
    engine.init(CIRCUIT);
    expect(engine.getState()).toBe("STOPPED");
    expect(engine.signals).toHaveLength(CIRCUIT.netCount);
  });

  it("init stores the circuit reference", () => {
    engine.init(CIRCUIT);
    expect(engine.circuit).toBe(CIRCUIT);
  });

  it("start transitions to RUNNING", () => {
    engine.init(CIRCUIT);
    engine.start();
    expect(engine.getState()).toBe("RUNNING");
  });

  it("stop transitions to PAUSED", () => {
    engine.init(CIRCUIT);
    engine.start();
    engine.stop();
    expect(engine.getState()).toBe("PAUSED");
  });

  it("reset transitions to STOPPED and zeroes signals", () => {
    engine.init(CIRCUIT);
    engine.setSignalRaw(0, 0xaabbccdd);
    engine.start();
    engine.reset();
    expect(engine.getState()).toBe("STOPPED");
    engine.resetCalls();
    expect(engine.getSignalRaw(0)).toBe(0);
  });

  it("dispose clears circuit reference and listeners", () => {
    engine.init(CIRCUIT);
    let notified = false;
    engine.addChangeListener(() => { notified = true; });
    engine.dispose();
    expect(engine.getState()).toBe("STOPPED");
    expect(engine.circuit).toBeNull();
    engine.start();
    expect(notified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signal access
// ---------------------------------------------------------------------------

describe("MockEngine signal access", () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = freshEngine();
    engine.resetCalls();
  });

  it("getSignalRaw returns 0 for freshly initialised net", () => {
    expect(engine.getSignalRaw(0)).toBe(0);
  });

  it("getSignalRaw returns 0 for out-of-bounds netId", () => {
    expect(engine.getSignalRaw(9999)).toBe(0);
  });

  it("setSignalRaw injects a value readable via getSignalRaw", () => {
    engine.setSignalRaw(5, 0xdeadbeef);
    expect(engine.getSignalRaw(5) >>> 0).toBe(0xdeadbeef >>> 0);
  });

  it("getSignalValue returns a BitVector with the stored value", () => {
    engine.setSignalRaw(3, 255);
    const bv = engine.getSignalValue(3);
    expect(bv).toBeInstanceOf(BitVector);
    expect(bv.toNumber()).toBe(255);
  });

  it("getSignalValue returns zero BitVector for out-of-bounds netId", () => {
    const bv = engine.getSignalValue(9999);
    expect(bv).toBeInstanceOf(BitVector);
    expect(bv.toNumber()).toBe(0);
  });

  it("setSignalValue stores value readable via getSignalRaw", () => {
    const bv = BitVector.fromNumber(99, 8);
    engine.setSignalValue(7, bv);
    engine.resetCalls();
    expect(engine.getSignalRaw(7)).toBe(99);
  });

  it("setSignalValue round-trips through getSignalValue", () => {
    const original = BitVector.fromNumber(123, 8);
    engine.setSignalValue(4, original);
    engine.resetCalls();
    const retrieved = engine.getSignalValue(4);
    expect(retrieved.toNumber()).toBe(123);
  });

  it("setSignalValue with HIGH_Z BitVector stores zero value and HIGH_Z mask", () => {
    const highZ = BitVector.allHighZ(8);
    engine.setSignalValue(6, highZ);
    engine.resetCalls();
    // Raw value for all-HIGH_Z should be 0
    expect(engine.getSignalRaw(6)).toBe(0);
    // getSignalValue should reflect the HIGH_Z state
    const bv = engine.getSignalValue(6);
    expect(bv.isHighZ).toBe(true);
  });

  it("uses net-specific width when set", () => {
    engine.setNetWidth(0, 16);
    engine.setSignalRaw(0, 1000);
    const bv = engine.getSignalValue(0);
    expect(bv.width).toBe(16);
    expect(bv.toNumber()).toBe(1000);
  });

  it("uses default width for nets without explicit override", () => {
    engine.setSignalRaw(1, 5);
    const bv = engine.getSignalValue(1);
    expect(bv.width).toBe(8);
  });

  it("setDefaultWidth changes width for all nets without explicit override", () => {
    engine.setDefaultWidth(4);
    engine.setSignalRaw(2, 10);
    const bv = engine.getSignalValue(2);
    expect(bv.width).toBe(4);
    expect(bv.toNumber()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Change listener
// ---------------------------------------------------------------------------

describe("MockEngine change listener", () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = freshEngine();
    engine.resetCalls();
  });

  it("addChangeListener receives state on start", () => {
    const states: EngineState[] = [];
    const listener: EngineChangeListener = (s) => states.push(s);
    engine.addChangeListener(listener);
    engine.start();
    expect(states).toEqual(["RUNNING"]);
  });

  it("addChangeListener receives state on stop", () => {
    const states: EngineState[] = [];
    engine.addChangeListener((s) => states.push(s));
    engine.start();
    engine.stop();
    expect(states).toEqual(["RUNNING", "PAUSED"]);
  });

  it("addChangeListener receives state on reset", () => {
    const states: EngineState[] = [];
    engine.addChangeListener((s) => states.push(s));
    engine.reset();
    expect(states).toEqual(["STOPPED"]);
  });

  it("removeChangeListener stops further notifications", () => {
    let count = 0;
    const listener: EngineChangeListener = () => { count++; };
    engine.addChangeListener(listener);
    engine.start();
    engine.removeChangeListener(listener);
    engine.stop();
    expect(count).toBe(1);
  });

  it("multiple listeners each receive notifications", () => {
    const a: EngineState[] = [];
    const b: EngineState[] = [];
    engine.addChangeListener((s) => a.push(s));
    engine.addChangeListener((s) => b.push(s));
    engine.start();
    expect(a).toEqual(["RUNNING"]);
    expect(b).toEqual(["RUNNING"]);
  });
});

// ---------------------------------------------------------------------------
// Call recording
// ---------------------------------------------------------------------------

describe("MockEngine call recording", () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = freshEngine();
    engine.resetCalls();
  });

  it("records step, microStep, runToBreak in order", () => {
    engine.step();
    engine.microStep();
    engine.runToBreak();
    expect(engine.calls.map((c) => c.method)).toEqual(["step", "microStep", "runToBreak"]);
  });

  it("records getSignalRaw with correct netId", () => {
    engine.getSignalRaw(9);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toEqual({ method: "getSignalRaw", netId: 9 });
  });

  it("records getSignalValue with correct netId", () => {
    engine.getSignalValue(5);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toEqual({ method: "getSignalValue", netId: 5 });
  });

  it("records setSignalValue with netId and value", () => {
    const bv = BitVector.fromNumber(7, 8);
    engine.setSignalValue(2, bv);
    expect(engine.calls).toHaveLength(1);
    const call = engine.calls[0];
    expect(call?.method).toBe("setSignalValue");
    if (call?.method === "setSignalValue") {
      expect(call.netId).toBe(2);
      expect(call.value).toBe(bv);
    }
  });

  it("records addChangeListener and removeChangeListener", () => {
    const listener: EngineChangeListener = () => undefined;
    engine.addChangeListener(listener);
    engine.removeChangeListener(listener);
    expect(engine.calls.map((c) => c.method)).toEqual([
      "addChangeListener",
      "removeChangeListener",
    ]);
  });

  it("resetCalls empties the call log", () => {
    engine.step();
    engine.step();
    engine.resetCalls();
    expect(engine.calls).toHaveLength(0);
  });

  it("init call is recorded with circuit reference", () => {
    const e2 = new MockEngine();
    e2.init(CIRCUIT);
    expect(e2.calls).toHaveLength(1);
    expect(e2.calls[0]).toEqual({ method: "init", circuit: CIRCUIT });
  });
});

// ---------------------------------------------------------------------------
// CompiledCircuit interface
// ---------------------------------------------------------------------------

describe("CompiledCircuit interface", () => {
  it("can be constructed as a plain object literal", () => {
    const cc: CompiledCircuit = { netCount: 32, componentCount: 8 };
    expect(cc.netCount).toBe(32);
    expect(cc.componentCount).toBe(8);
  });
});
