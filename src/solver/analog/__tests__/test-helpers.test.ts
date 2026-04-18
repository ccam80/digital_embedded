import { describe, it, expect } from "vitest";
import { makeResistor, makeVoltageSource, makeCurrentSource, makeDiode } from "./test-helpers.js";

describe("mock_factory", () => {
  it("returns_load_ctx_interface", () => {
    const mock = makeResistor(1, 2, 1000);

    expect(typeof mock.load).toBe("function");
    expect((mock as Record<string, unknown>)["stamp"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["stampNonlinear"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["updateOperatingPoint"]).toBeUndefined();
  });

  it("voltage_source_returns_load_ctx_interface", () => {
    const mock = makeVoltageSource(1, 0, 2, 5);

    expect(typeof mock.load).toBe("function");
    expect((mock as Record<string, unknown>)["stamp"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["stampNonlinear"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["updateOperatingPoint"]).toBeUndefined();
  });

  it("current_source_returns_load_ctx_interface", () => {
    const mock = makeCurrentSource(1, 0, 0.001);

    expect(typeof mock.load).toBe("function");
    expect((mock as Record<string, unknown>)["stamp"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["stampNonlinear"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["updateOperatingPoint"]).toBeUndefined();
  });

  it("diode_returns_load_ctx_interface", () => {
    const mock = makeDiode(1, 0, 1e-14, 1.0);

    expect(typeof mock.load).toBe("function");
    expect((mock as Record<string, unknown>)["stamp"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["stampNonlinear"]).toBeUndefined();
    expect((mock as Record<string, unknown>)["updateOperatingPoint"]).toBeUndefined();
  });
});
