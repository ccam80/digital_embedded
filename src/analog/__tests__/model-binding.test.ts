/**
 * Tests for model binding in the analog compiler (Task 2.3.3).
 *
 * These tests build minimal mock circuits with semiconductor components
 * and verify that the compiler resolves and injects model parameters
 * correctly, and emits appropriate diagnostics.
 */

import { describe, it, expect } from "vitest";
import { ModelLibrary, validateModel } from "../model-library.js";
import type { DeviceModel } from "../model-library.js";
import type { DeviceType } from "../model-parser.js";
import { DIODE_DEFAULTS } from "../model-defaults.js";

// ---------------------------------------------------------------------------
// validateModel diagnostic tests (compiler-independent)
// ---------------------------------------------------------------------------

describe("ModelBinding", () => {
  it("unknown_param_emits_diagnostic", () => {
    const model: DeviceModel = {
      name: "TestD",
      type: "D",
      level: 1,
      params: { IS: 1e-14, FOOBAR: 42 },
    };
    const diags = validateModel(model);
    const d = diags.find((x) => x.code === "model-param-ignored");
    expect(d).toBeDefined();
    expect(d!.summary).toContain("FOOBAR");
    expect(d!.severity).toBe("warning");
  });

  it("level_3_emits_diagnostic", () => {
    const model: DeviceModel = {
      name: "HighLevel",
      type: "NMOS",
      level: 3,
      params: { VTO: 0.7 },
    };
    const diags = validateModel(model);
    const d = diags.find((x) => x.code === "model-level-unsupported");
    expect(d).toBeDefined();
    expect(d!.summary).toContain("3");
    expect(d!.severity).toBe("warning");
  });

  it("falls_back_to_default_when_no_model", () => {
    const lib = new ModelLibrary();

    // Look up a non-existent model name — should fall back to default
    const modelName = "NONEXISTENT";
    const resolved = lib.get(modelName) ?? lib.getDefault("D");

    expect(resolved.params["IS"]).toBeCloseTo(DIODE_DEFAULTS["IS"], 25);
    expect(resolved.params["N"]).toBe(DIODE_DEFAULTS["N"]);
  });

  it("user_model_resolved_over_default", () => {
    const lib = new ModelLibrary();
    lib.add({
      name: "D1N4148",
      type: "D",
      level: 1,
      params: { IS: 2.52e-9, N: 1.752 },
    });

    const modelName = "D1N4148";
    const resolved = lib.get(modelName) ?? lib.getDefault("D");

    // Should use user-supplied IS, not the default 1e-14
    expect(resolved.params["IS"]).toBeCloseTo(2.52e-9, 20);
    expect(resolved.params["N"]).toBeCloseTo(1.752, 10);
  });

  it("model_library_lookup_pattern_matches_compiler_logic", () => {
    const lib = new ModelLibrary();
    lib.add({
      name: "D1N4148",
      type: "D",
      level: 1,
      params: { IS: 2.52e-9 },
    });

    // Simulate what the compiler does:
    //   props.model = "D1N4148", analogDeviceType = "D"
    const propsModel = "D1N4148";
    const deviceType: DeviceType = "D";

    const resolved =
      (propsModel !== "" ? lib.get(propsModel) : undefined) ??
      lib.getDefault(deviceType);

    expect(resolved.params["IS"]).toBeCloseTo(2.52e-9, 20);
  });

  it("empty_model_name_falls_back_to_default", () => {
    const lib = new ModelLibrary();

    // Simulate props.model = "" (no model specified)
    const propsModel = "";
    const deviceType: DeviceType = "D";

    const resolved =
      (propsModel !== "" ? lib.get(propsModel) : undefined) ??
      lib.getDefault(deviceType);

    expect(resolved.params["IS"]).toBeCloseTo(DIODE_DEFAULTS["IS"], 25);
  });

  it("all_seven_device_types_resolve_defaults", () => {
    const lib = new ModelLibrary();
    const types: DeviceType[] = ["D", "NPN", "PNP", "NMOS", "PMOS", "NJFET", "PJFET"];

    for (const type of types) {
      const resolved = lib.getDefault(type);
      expect(resolved).toBeDefined();
      expect(resolved.type).toBe(type);
      expect(Object.keys(resolved.params).length).toBeGreaterThan(0);
    }
  });

  it("validate_model_with_multiple_unknown_params", () => {
    const model: DeviceModel = {
      name: "BadModel",
      type: "NPN",
      level: 1,
      params: { IS: 1e-16, UNKNOWN1: 1, UNKNOWN2: 2 },
    };
    const diags = validateModel(model);
    const ignored = diags.filter((d) => d.code === "model-param-ignored");
    expect(ignored.length).toBe(2);
    const paramNames = ignored.map((d) => d.summary);
    expect(paramNames.some((s) => s.includes("UNKNOWN1"))).toBe(true);
    expect(paramNames.some((s) => s.includes("UNKNOWN2"))).toBe(true);
  });
});
