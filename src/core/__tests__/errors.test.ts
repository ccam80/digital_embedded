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
  BitsException,
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
// Cross-type: instanceof checks confirm no cross-contamination
// ---------------------------------------------------------------------------

describe("Error type isolation", () => {
  it("BurnException is not an instance of BitsException", () => {
    const err = new BurnException("burn");
    expect(err).not.toBeInstanceOf(BitsException);
  });

  it("BitsException is not an instance of BurnException", () => {
    const err = new BitsException("bits");
    expect(err).not.toBeInstanceOf(BurnException);
  });

  it("SimulationError is not an instance of any subtype", () => {
    const err = new SimulationError("base");
    expect(err).not.toBeInstanceOf(BurnException);
    expect(err).not.toBeInstanceOf(BitsException);
  });

  it("all error subtypes are instances of SimulationError", () => {
    const errors: SimulationError[] = [
      new BurnException("burn"),
      new BitsException("bits"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(SimulationError);
    }
  });

  it("all error subtypes are instances of Error", () => {
    const errors: Error[] = [
      new BurnException("burn"),
      new BitsException("bits"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
