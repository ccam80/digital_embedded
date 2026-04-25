import { describe, it, expect } from "vitest";
import { defineModelParams } from "../model-params.js";
import { PropertyType } from "../properties.js";
import { BJT_PARAM_DEFS, BJT_DEFAULTS, RESISTOR_PARAM_DEFS, RESISTOR_DEFAULTS } from "../../test-fixtures/model-fixtures.js";

describe("defineModelParams", () => {
  it("returns paramDefs with correct rank assignment for primary params", () => {
    const { paramDefs } = defineModelParams({
      primary: {
        R: { default: 100, unit: "\u03A9", description: "Resistance" },
      },
    });
    expect(paramDefs).toHaveLength(1);
    expect(paramDefs[0]!.key).toBe("R");
    expect(paramDefs[0]!.rank).toBe("primary");
    expect(paramDefs[0]!.type).toBe(PropertyType.FLOAT);
    expect(paramDefs[0]!.label).toBe("R");
    expect(paramDefs[0]!.unit).toBe("\u03A9");
    expect(paramDefs[0]!.description).toBe("Resistance");
  });

  it("returns paramDefs with correct rank assignment for secondary params", () => {
    const { paramDefs } = defineModelParams({
      primary: {
        BF: { default: 100 },
      },
      secondary: {
        NF: { default: 1, description: "Forward emission coefficient" },
      },
    });
    expect(paramDefs).toHaveLength(2);
    const primary = paramDefs.find((p) => p.key === "BF")!;
    const secondary = paramDefs.find((p) => p.key === "NF")!;
    expect(primary.rank).toBe("primary");
    expect(secondary.rank).toBe("secondary");
    expect(secondary.description).toBe("Forward emission coefficient");
  });

  it("returns defaults record with all param values", () => {
    const { defaults } = defineModelParams({
      primary: {
        BF: { default: 100 },
        IS: { default: 1e-14 },
      },
      secondary: {
        NF: { default: 1 },
      },
    });
    expect(defaults).toEqual({ BF: 100, IS: 1e-14, NF: 1 });
  });

  it("handles primary-only spec without secondary", () => {
    const { paramDefs, defaults } = defineModelParams({
      primary: {
        resistance: { default: 1000, unit: "\u03A9" },
      },
    });
    expect(paramDefs).toHaveLength(1);
    expect(defaults).toEqual({ resistance: 1000 });
  });

  it("preserves min and max constraints", () => {
    const { paramDefs } = defineModelParams({
      primary: {
        BF: { default: 100, min: 1, max: 10000 },
      },
    });
    expect(paramDefs[0]!.min).toBe(1);
    expect(paramDefs[0]!.max).toBe(10000);
  });

  it("handles Infinity default values", () => {
    const { defaults } = defineModelParams({
      primary: {
        VAF: { default: Infinity, unit: "V" },
      },
    });
    expect(defaults.VAF).toBe(Infinity);
  });

  it("shared fixture BJT_PARAM_DEFS has correct structure", () => {
    expect(BJT_PARAM_DEFS.length).toBe(5);
    const primaryKeys = BJT_PARAM_DEFS.filter((p) => p.rank === "primary").map((p) => p.key);
    const secondaryKeys = BJT_PARAM_DEFS.filter((p) => p.rank === "secondary").map((p) => p.key);
    expect(primaryKeys).toEqual(["BF", "IS"]);
    expect(secondaryKeys).toEqual(["NF", "BR", "VAF"]);
  });

  it("shared fixture BJT_DEFAULTS has correct values", () => {
    expect(BJT_DEFAULTS).toEqual({
      BF: 100,
      IS: 1e-14,
      NF: 1,
      BR: 1,
      VAF: Infinity,
    });
  });

  it("shared fixture RESISTOR_PARAM_DEFS has one primary param", () => {
    expect(RESISTOR_PARAM_DEFS).toHaveLength(1);
    expect(RESISTOR_PARAM_DEFS[0]!.key).toBe("resistance");
    expect(RESISTOR_PARAM_DEFS[0]!.rank).toBe("primary");
  });

  it("shared fixture RESISTOR_DEFAULTS has correct value", () => {
    expect(RESISTOR_DEFAULTS).toEqual({ resistance: 1000 });
  });

  describe("defineModelParams partition tagging", () => {
    it("primary params get partition='model'", () => {
      const result = defineModelParams({ primary: { IS: { default: 1e-14 } } });
      expect(result.paramDefs[0]!.partition).toBe("model");
    });

    it("secondary params get partition='model'", () => {
      const result = defineModelParams({
        primary: { IS: { default: 1 } },
        secondary: { N: { default: 1 } },
      });
      const nEntry = result.paramDefs.find((d) => d.key === "N")!;
      expect(nEntry.partition).toBe("model");
    });

    it("instance params get partition='instance' and rank='secondary'", () => {
      const result = defineModelParams({
        primary: { IS: { default: 1 } },
        instance: { OFF: { default: 0 } },
      });
      const offEntry = result.paramDefs.find((d) => d.key === "OFF")!;
      expect(offEntry.partition).toBe("instance");
      expect(offEntry.rank).toBe("secondary");
    });

    it("instance defaults merge into the same defaults record", () => {
      const result = defineModelParams({
        primary: { IS: { default: 1 } },
        instance: { OFF: { default: 0 } },
      });
      expect(result.defaults.OFF).toBe(0);
      expect(result.defaults.IS).toBe(1);
    });

    it("emission order is primary then secondary then instance", () => {
      const result = defineModelParams({
        primary: { A: { default: 1 } },
        secondary: { B: { default: 2 } },
        instance: { C: { default: 3 } },
      });
      expect(result.paramDefs.map((d) => d.key)).toEqual(["A", "B", "C"]);
    });

    it("omitting instance does not change paramDefs[]", () => {
      const result = defineModelParams({ primary: { IS: { default: 1 } } });
      expect(result.paramDefs).toHaveLength(1);
      expect(result.paramDefs[0]!.partition).toBe("model");
    });
  });
});
