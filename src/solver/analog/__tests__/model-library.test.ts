import { describe, it, expect } from "vitest";
import { ModelLibrary, validateModel } from "../model-library.js";
import type { DeviceModel } from "../model-library.js";
import type { DeviceType } from "../../../core/analog-types.js";
import { DIODE_DEFAULTS } from "../model-defaults.js";

describe("ModelLibrary", () => {
  it("add_and_get", () => {
    const lib = new ModelLibrary();
    const model: DeviceModel = {
      name: "1N4148",
      type: "D",
      level: 1,
      params: { IS: 2.52e-9, N: 1.752, RS: 0.568 },
    };
    lib.add(model);

    const retrieved = lib.get("1N4148");
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("1N4148");
    expect(retrieved!.type).toBe("D");
    expect(retrieved!.level).toBe(1);
    expect(retrieved!.params["IS"]).toBeCloseTo(2.52e-9, 20);
    expect(retrieved!.params["N"]).toBeCloseTo(1.752, 10);
    expect(retrieved!.params["RS"]).toBeCloseTo(0.568, 10);
  });

  it("get_returns_undefined_for_unknown_name", () => {
    const lib = new ModelLibrary();
    expect(lib.get("NOSUCHMODEL")).toBeUndefined();
  });

  it("get_default_diode", () => {
    const lib = new ModelLibrary();
    const def = lib.getDefault("D");

    expect(def).toBeDefined();
    expect(def.type).toBe("D");
    expect(def.params["IS"]).toBeCloseTo(1e-14, 25);
    expect(def.params["N"]).toBe(1);
    expect(def.params["RS"]).toBe(0);
    expect(def.params["BV"]).toBe(Number.POSITIVE_INFINITY);
    expect(def.params["IBV"]).toBeCloseTo(1e-3, 10);
    expect(def.params["CJO"]).toBe(0);
    expect(def.params["VJ"]).toBeCloseTo(0.7, 10);
    expect(def.params["M"]).toBeCloseTo(0.5, 10);
    expect(def.params["TT"]).toBe(0);
    expect(def.params["EG"]).toBeCloseTo(1.11, 10);
    expect(def.params["XTI"]).toBe(3);
    expect(def.params["KF"]).toBe(0);
    expect(def.params["AF"]).toBe(1);
  });

  it("get_default_bjt", () => {
    const lib = new ModelLibrary();
    const def = lib.getDefault("NPN");

    expect(def).toBeDefined();
    expect(def.type).toBe("NPN");
    // Spec: 26 params, BF > 0, IS > 0
    expect(Object.keys(def.params).length).toBe(26);
    expect(def.params["BF"]).toBeGreaterThan(0);
    expect(def.params["IS"]).toBeGreaterThan(0);
  });

  it("get_default_mosfet", () => {
    const lib = new ModelLibrary();
    const def = lib.getDefault("NMOS");

    expect(def).toBeDefined();
    expect(def.type).toBe("NMOS");
    // Spec: 25 params, VTO > 0, KP > 0
    expect(Object.keys(def.params).length).toBe(25);
    expect(def.params["VTO"]).toBeGreaterThan(0);
    expect(def.params["KP"]).toBeGreaterThan(0);
  });

  it("user_model_overrides_default", () => {
    const lib = new ModelLibrary();
    const custom: DeviceModel = {
      name: "custom_d",
      type: "D",
      level: 1,
      params: { IS: 1e-10 },
    };
    lib.add(custom);

    const retrieved = lib.get("custom_d");
    expect(retrieved).toBeDefined();
    expect(retrieved!.params["IS"]).toBeCloseTo(1e-10, 20);
  });

  it("add_overwrites_existing_model", () => {
    const lib = new ModelLibrary();
    lib.add({ name: "MyD", type: "D", level: 1, params: { IS: 1e-14 } });
    lib.add({ name: "MyD", type: "D", level: 1, params: { IS: 5e-12 } });

    const retrieved = lib.get("MyD");
    expect(retrieved!.params["IS"]).toBeCloseTo(5e-12, 20);
  });

  it("clear_removes_user_models_not_defaults", () => {
    const lib = new ModelLibrary();
    lib.add({ name: "custom_d", type: "D", level: 1, params: { IS: 1e-10 } });
    expect(lib.get("custom_d")).toBeDefined();

    lib.clear();

    expect(lib.get("custom_d")).toBeUndefined();
    // Built-in defaults must still work
    const def = lib.getDefault("D");
    expect(def).toBeDefined();
    expect(def.params["IS"]).toBeCloseTo(1e-14, 25);
  });

  it("all_device_types_have_defaults", () => {
    const lib = new ModelLibrary();
    const types: DeviceType[] = ["D", "NPN", "PNP", "NMOS", "PMOS", "NJFET", "PJFET"];

    for (const type of types) {
      const def = lib.getDefault(type);
      expect(def).toBeDefined();
      expect(def.type).toBe(type);
      expect(Object.keys(def.params).length).toBeGreaterThan(0);
    }
  });

  it("remove_deletes_user_model", () => {
    const lib = new ModelLibrary();
    lib.add({ name: "DelMe", type: "D", level: 1, params: { IS: 1e-14 } });
    const removed = lib.remove("DelMe");
    expect(removed).toBe(true);
    expect(lib.get("DelMe")).toBeUndefined();
  });

  it("remove_returns_false_for_nonexistent", () => {
    const lib = new ModelLibrary();
    expect(lib.remove("NOSUCHMODEL")).toBe(false);
  });

  it("getAll_returns_only_user_models", () => {
    const lib = new ModelLibrary();
    lib.add({ name: "A", type: "D", level: 1, params: {} });
    lib.add({ name: "B", type: "NPN", level: 1, params: {} });

    const all = lib.getAll();
    expect(all.length).toBe(2);
    const names = all.map((m) => m.name).sort();
    expect(names).toEqual(["A", "B"]);
  });

  it("getDefault_returns_fresh_copy", () => {
    const lib = new ModelLibrary();
    const def1 = lib.getDefault("D");
    def1.params["IS"] = 999;

    const def2 = lib.getDefault("D");
    // Mutation of first copy must not affect subsequent calls
    expect(def2.params["IS"]).toBeCloseTo(1e-14, 25);
  });
});

describe("validateModel", () => {
  it("unknown_param_emits_model_param_ignored", () => {
    const model: DeviceModel = {
      name: "TestD",
      type: "D",
      level: 1,
      params: { IS: 1e-14, FOOBAR: 42 },
    };
    const diags = validateModel(model);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    const d = diags.find((x) => x.code === "model-param-ignored");
    expect(d).toBeDefined();
    expect(d!.summary).toContain("FOOBAR");
  });

  it("level_3_emits_model_level_unsupported", () => {
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
  });

  it("valid_model_produces_no_diagnostics", () => {
    const model: DeviceModel = {
      name: "CleanD",
      type: "D",
      level: 1,
      params: { IS: 1e-14, N: 1 },
    };
    const diags = validateModel(model);
    expect(diags).toHaveLength(0);
  });

  it("level_2_does_not_emit_level_diagnostic", () => {
    const model: DeviceModel = {
      name: "Level2D",
      type: "D",
      level: 2,
      params: {},
    };
    const diags = validateModel(model);
    expect(diags.find((x) => x.code === "model-level-unsupported")).toBeUndefined();
  });
});
