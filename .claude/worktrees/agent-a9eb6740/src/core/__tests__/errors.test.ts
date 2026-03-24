/**
 * Unit tests for the error type taxonomy.
 *
 * Each error type must:
 * - Be constructable with a message
 * - Have the correct .name property
 * - Be an instance of both its own type and SimulationError
 * - Carry the context fields defined in its spec
 * - Work correctly when context fields are omitted (optional fields default gracefully)
 */

import { describe, it, expect } from "vitest";
import {
  SimulationError,
  BurnException,
  BacktrackException,
  BitsException,
  NodeException,
  PinException,
} from "../errors.js";

// ---------------------------------------------------------------------------
// SimulationError (base)
// ---------------------------------------------------------------------------

describe("SimulationError", () => {
  it("is an instance of Error", () => {
    const err = new SimulationError("base error");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name SimulationError", () => {
    const err = new SimulationError("base error");
    expect(err.name).toBe("SimulationError");
  });

  it("carries the message", () => {
    const err = new SimulationError("something failed");
    expect(err.message).toBe("something failed");
  });

  it("componentId is undefined when not provided", () => {
    const err = new SimulationError("msg");
    expect(err.componentId).toBeUndefined();
  });

  it("netId is undefined when not provided", () => {
    const err = new SimulationError("msg");
    expect(err.netId).toBeUndefined();
  });

  it("carries componentId when provided", () => {
    const err = new SimulationError("msg", { componentId: "gate-42" });
    expect(err.componentId).toBe("gate-42");
  });

  it("carries netId when provided", () => {
    const err = new SimulationError("msg", { netId: 7 });
    expect(err.netId).toBe(7);
  });

  it("carries both componentId and netId when provided", () => {
    const err = new SimulationError("msg", { componentId: "and-1", netId: 3 });
    expect(err.componentId).toBe("and-1");
    expect(err.netId).toBe(3);
  });

  it("has a stack trace", () => {
    const err = new SimulationError("msg");
    expect(typeof err.stack).toBe("string");
    expect(err.stack!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BurnException
// ---------------------------------------------------------------------------

describe("BurnException", () => {
  it("is an instance of SimulationError", () => {
    const err = new BurnException("shorted");
    expect(err).toBeInstanceOf(SimulationError);
  });

  it("is an instance of BurnException", () => {
    const err = new BurnException("shorted");
    expect(err).toBeInstanceOf(BurnException);
  });

  it("is an instance of Error", () => {
    const err = new BurnException("shorted");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name BurnException", () => {
    const err = new BurnException("shorted");
    expect(err.name).toBe("BurnException");
  });

  it("carries the message", () => {
    const err = new BurnException("net 5 shorted");
    expect(err.message).toBe("net 5 shorted");
  });

  it("conflictingValues defaults to empty array when not provided", () => {
    const err = new BurnException("shorted");
    expect(err.conflictingValues).toEqual([]);
  });

  it("carries conflictingValues when provided", () => {
    const err = new BurnException("shorted", { conflictingValues: [0, 1] });
    expect(err.conflictingValues).toEqual([0, 1]);
  });

  it("carries componentId and netId from base", () => {
    const err = new BurnException("shorted", { componentId: "out-1", netId: 4 });
    expect(err.componentId).toBe("out-1");
    expect(err.netId).toBe(4);
  });

  it("conflictingValues is readonly (array reference is stable)", () => {
    const vals = [0, 1, 0];
    const err = new BurnException("shorted", { conflictingValues: vals });
    expect(err.conflictingValues).toEqual([0, 1, 0]);
  });
});

// ---------------------------------------------------------------------------
// BacktrackException
// ---------------------------------------------------------------------------

describe("BacktrackException", () => {
  it("is an instance of SimulationError", () => {
    const err = new BacktrackException("backtrack exhausted");
    expect(err).toBeInstanceOf(SimulationError);
  });

  it("is an instance of BacktrackException", () => {
    const err = new BacktrackException("backtrack exhausted");
    expect(err).toBeInstanceOf(BacktrackException);
  });

  it("is an instance of Error", () => {
    const err = new BacktrackException("backtrack exhausted");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name BacktrackException", () => {
    const err = new BacktrackException("backtrack exhausted");
    expect(err.name).toBe("BacktrackException");
  });

  it("carries the message", () => {
    const err = new BacktrackException("switching network unstable");
    expect(err.message).toBe("switching network unstable");
  });

  it("attempts defaults to 0 when not provided", () => {
    const err = new BacktrackException("failed");
    expect(err.attempts).toBe(0);
  });

  it("carries attempts when provided", () => {
    const err = new BacktrackException("failed", { attempts: 10 });
    expect(err.attempts).toBe(10);
  });

  it("carries componentId and netId from base", () => {
    const err = new BacktrackException("failed", { componentId: "switch-3", netId: 9 });
    expect(err.componentId).toBe("switch-3");
    expect(err.netId).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// BitsException
// ---------------------------------------------------------------------------

describe("BitsException", () => {
  it("is an instance of SimulationError", () => {
    const err = new BitsException("bit-width mismatch");
    expect(err).toBeInstanceOf(SimulationError);
  });

  it("is an instance of BitsException", () => {
    const err = new BitsException("bit-width mismatch");
    expect(err).toBeInstanceOf(BitsException);
  });

  it("is an instance of Error", () => {
    const err = new BitsException("bit-width mismatch");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name BitsException", () => {
    const err = new BitsException("bit-width mismatch");
    expect(err.name).toBe("BitsException");
  });

  it("carries the message", () => {
    const err = new BitsException("expected 8 bits, got 1");
    expect(err.message).toBe("expected 8 bits, got 1");
  });

  it("expectedBits defaults to 0 when not provided", () => {
    const err = new BitsException("mismatch");
    expect(err.expectedBits).toBe(0);
  });

  it("actualBits defaults to 0 when not provided", () => {
    const err = new BitsException("mismatch");
    expect(err.actualBits).toBe(0);
  });

  it("carries expectedBits and actualBits when provided", () => {
    const err = new BitsException("mismatch", { expectedBits: 8, actualBits: 1 });
    expect(err.expectedBits).toBe(8);
    expect(err.actualBits).toBe(1);
  });

  it("carries componentId and netId from base", () => {
    const err = new BitsException("mismatch", { componentId: "bus-1", netId: 2, expectedBits: 8, actualBits: 4 });
    expect(err.componentId).toBe("bus-1");
    expect(err.netId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// NodeException
// ---------------------------------------------------------------------------

describe("NodeException", () => {
  it("is an instance of SimulationError", () => {
    const err = new NodeException("node eval failed");
    expect(err).toBeInstanceOf(SimulationError);
  });

  it("is an instance of NodeException", () => {
    const err = new NodeException("node eval failed");
    expect(err).toBeInstanceOf(NodeException);
  });

  it("is an instance of Error", () => {
    const err = new NodeException("node eval failed");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name NodeException", () => {
    const err = new NodeException("node eval failed");
    expect(err.name).toBe("NodeException");
  });

  it("carries the message", () => {
    const err = new NodeException("decoder overflow");
    expect(err.message).toBe("decoder overflow");
  });

  it("carries componentId and netId from base", () => {
    const err = new NodeException("failed", { componentId: "dec-7", netId: 11 });
    expect(err.componentId).toBe("dec-7");
    expect(err.netId).toBe(11);
  });

  it("componentId is undefined when not provided", () => {
    const err = new NodeException("failed");
    expect(err.componentId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PinException
// ---------------------------------------------------------------------------

describe("PinException", () => {
  it("is an instance of SimulationError", () => {
    const err = new PinException("pin unconnected");
    expect(err).toBeInstanceOf(SimulationError);
  });

  it("is an instance of PinException", () => {
    const err = new PinException("pin unconnected");
    expect(err).toBeInstanceOf(PinException);
  });

  it("is an instance of Error", () => {
    const err = new PinException("pin unconnected");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name PinException", () => {
    const err = new PinException("pin unconnected");
    expect(err.name).toBe("PinException");
  });

  it("carries the message", () => {
    const err = new PinException("input A is unconnected");
    expect(err.message).toBe("input A is unconnected");
  });

  it("pinLabel is undefined when not provided", () => {
    const err = new PinException("unconnected");
    expect(err.pinLabel).toBeUndefined();
  });

  it("carries pinLabel when provided", () => {
    const err = new PinException("unconnected", { pinLabel: "A" });
    expect(err.pinLabel).toBe("A");
  });

  it("carries componentId and netId from base", () => {
    const err = new PinException("unconnected", { componentId: "and-2", netId: 5, pinLabel: "B" });
    expect(err.componentId).toBe("and-2");
    expect(err.netId).toBe(5);
    expect(err.pinLabel).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// Cross-type: instanceof checks confirm no cross-contamination
// ---------------------------------------------------------------------------

describe("Error type isolation", () => {
  it("BurnException is not an instance of BacktrackException", () => {
    const err = new BurnException("burn");
    expect(err).not.toBeInstanceOf(BacktrackException);
  });

  it("BitsException is not an instance of PinException", () => {
    const err = new BitsException("bits");
    expect(err).not.toBeInstanceOf(PinException);
  });

  it("NodeException is not an instance of BurnException", () => {
    const err = new NodeException("node");
    expect(err).not.toBeInstanceOf(BurnException);
  });

  it("PinException is not an instance of BitsException", () => {
    const err = new PinException("pin");
    expect(err).not.toBeInstanceOf(BitsException);
  });

  it("SimulationError is not an instance of any subtype", () => {
    const err = new SimulationError("base");
    expect(err).not.toBeInstanceOf(BurnException);
    expect(err).not.toBeInstanceOf(BacktrackException);
    expect(err).not.toBeInstanceOf(BitsException);
    expect(err).not.toBeInstanceOf(NodeException);
    expect(err).not.toBeInstanceOf(PinException);
  });

  it("all error subtypes are instances of SimulationError", () => {
    const errors: SimulationError[] = [
      new BurnException("burn"),
      new BacktrackException("backtrack"),
      new BitsException("bits"),
      new NodeException("node"),
      new PinException("pin"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(SimulationError);
    }
  });

  it("all error subtypes are instances of Error", () => {
    const errors: Error[] = [
      new BurnException("burn"),
      new BacktrackException("backtrack"),
      new BitsException("bits"),
      new NodeException("node"),
      new PinException("pin"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
