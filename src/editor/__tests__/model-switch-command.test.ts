/**
 * Unit tests for createModelSwitchCommand givenness handling.
 *
 * A model switch reseeds the new model's defaults (not given); undo must restore
 * the exact prior state, including which params the user had overridden (given).
 */

import { describe, it, expect } from "vitest";
import { createModelSwitchCommand } from "../model-switch-command.js";
import { PropertyBag } from "../../core/properties.js";
import { TestElement } from "../../test-fixtures/test-element.js";

function makeBjt(): TestElement {
  const bag = new PropertyBag([["model", "behavioral"]]);
  bag.replaceModelParams({ BF: 100, IS: 1e-14 }); // seeded defaults, not given
  bag.setModelParam("BF", 300); // user override → given
  return new TestElement("NpnBJT", "q1", { x: 0, y: 0 }, [], bag);
}

describe("createModelSwitchCommand givenness", () => {
  it("switch reseeds the new model's params as not-given", () => {
    const el = makeBjt();
    const cmd = createModelSwitchCommand(el, "2N2222", { BF: 200, IS: 1e-14 });
    cmd.execute();

    const bag = el.getProperties();
    expect(bag.getModelParam<number>("BF")).toBe(200);
    expect(bag.isModelParamGiven("BF")).toBe(false);
    expect(bag.isModelParamGiven("IS")).toBe(false);
  });

  it("undo restores both the value and the givenness of a user override", () => {
    const el = makeBjt();
    const cmd = createModelSwitchCommand(el, "2N2222", { BF: 200, IS: 1e-14 });
    cmd.execute();
    cmd.undo();

    const bag = el.getProperties();
    expect(bag.get("model")).toBe("behavioral");
    // BF was a given override before the switch- value and given flag both return.
    expect(bag.getModelParam<number>("BF")).toBe(300);
    expect(bag.isModelParamGiven("BF")).toBe(true);
    // IS was seeded not-given- it stays not-given (no false-given on undo).
    expect(bag.getModelParam<number>("IS")).toBe(1e-14);
    expect(bag.isModelParamGiven("IS")).toBe(false);
  });
});
