import { describe, it, expect } from "vitest";
import { PropertyBag } from "../properties.js";
import {
  createTestPropertyBag,
  RESISTOR_MODEL_ENTRY,
  BJT_MODEL_ENTRY,
} from "../../test-fixtures/model-fixtures.js";

describe("PropertyBag model param partition", () => {
  it("getModelParam returns value from model partition", () => {
    const bag = createTestPropertyBag();
    bag.setModelParam("BF", 100);
    expect(bag.getModelParam<number>("BF")).toBe(100);
  });

  it("getModelParam throws if key is absent", () => {
    const bag = createTestPropertyBag();
    expect(() => bag.getModelParam("missing")).toThrow(
      'PropertyBag: model param "missing" not found',
    );
  });

  it("setModelParam writes to model partition, not static partition", () => {
    const bag = createTestPropertyBag({ label: "R1" });
    bag.setModelParam("resistance", 4700);
    expect(bag.getModelParam<number>("resistance")).toBe(4700);
    expect(bag.get<string>("label")).toBe("R1");
    expect(bag.has("resistance")).toBe(false);
  });

  it("static get/set are unaffected by model param operations", () => {
    const bag = createTestPropertyBag({ label: "Q1", bits: 8 });
    bag.setModelParam("BF", 200);
    bag.setModelParam("IS", 1e-14);
    expect(bag.get<string>("label")).toBe("Q1");
    expect(bag.get<number>("bits")).toBe(8);
    bag.set("label", "Q2");
    expect(bag.get<string>("label")).toBe("Q2");
    expect(bag.getModelParam<number>("BF")).toBe(200);
  });

  it("replaceModelParams clears old partition and writes new values", () => {
    const bag = createTestPropertyBag();
    bag.setModelParam("BF", 100);
    bag.setModelParam("IS", 1e-14);
    bag.replaceModelParams({ resistance: 1000 });
    expect(bag.hasModelParam("BF")).toBe(false);
    expect(bag.hasModelParam("IS")).toBe(false);
    expect(bag.getModelParam<number>("resistance")).toBe(1000);
  });

  it("replaceModelParams with empty object clears all model params", () => {
    const bag = createTestPropertyBag();
    bag.setModelParam("BF", 100);
    bag.replaceModelParams({});
    expect(bag.getModelParamKeys()).toEqual([]);
  });

  it("getModelParamKeys returns only model param keys", () => {
    const bag = createTestPropertyBag({ label: "R1" });
    bag.setModelParam("resistance", 1000);
    bag.setModelParam("tolerance", 0.05);
    const keys = bag.getModelParamKeys();
    expect(keys).toEqual(["resistance", "tolerance"]);
    expect(keys).not.toContain("label");
  });

  it("hasModelParam returns true only for model partition keys", () => {
    const bag = createTestPropertyBag({ label: "R1" });
    bag.setModelParam("resistance", 1000);
    expect(bag.hasModelParam("resistance")).toBe(true);
    expect(bag.hasModelParam("label")).toBe(false);
    expect(bag.hasModelParam("missing")).toBe(false);
  });

  it("clone preserves model params in the cloned bag", () => {
    const original = createTestPropertyBag({ label: "Q1" });
    original.setModelParam("BF", 100);
    original.setModelParam("IS", 1e-14);
    const cloned = original.clone();
    expect(cloned.getModelParam<number>("BF")).toBe(100);
    expect(cloned.getModelParam<number>("IS")).toBe(1e-14);
    expect(cloned.get<string>("label")).toBe("Q1");
  });

  it("clone creates independent model param partition", () => {
    const original = createTestPropertyBag();
    original.setModelParam("BF", 100);
    const cloned = original.clone();
    cloned.setModelParam("BF", 200);
    expect(original.getModelParam<number>("BF")).toBe(100);
    expect(cloned.getModelParam<number>("BF")).toBe(200);
  });

  it("replaceModelParams with fixture model entry params", () => {
    const bag = createTestPropertyBag({ label: "R1" });
    bag.replaceModelParams(RESISTOR_MODEL_ENTRY.params);
    expect(bag.getModelParam<number>("resistance")).toBe(1000);
    expect(bag.getModelParamKeys()).toEqual(["resistance"]);
    expect(bag.get<string>("label")).toBe("R1");
  });

  it("model switch via replaceModelParams from BJT to resistor", () => {
    const bag = createTestPropertyBag();
    bag.replaceModelParams(BJT_MODEL_ENTRY.params);
    expect(bag.getModelParamKeys().sort()).toEqual(["BF", "BR", "IS", "NF", "VAF"].sort());
    expect(bag.getModelParam<number>("BF")).toBe(100);

    bag.replaceModelParams(RESISTOR_MODEL_ENTRY.params);
    expect(bag.getModelParamKeys()).toEqual(["resistance"]);
    expect(bag.getModelParam<number>("resistance")).toBe(1000);
    expect(bag.hasModelParam("BF")).toBe(false);
  });
});
