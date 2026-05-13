/**
 * Param hot-load tests for the 8 gate driver leaf elements.
 *
 * Asserts that setParam("rOut", 200), setParam("vOH", 3.3), and
 * setParam("vOL", 0.5) do not throw on direct-constructed element instances.
 */

import { describe, it, expect } from "vitest";
import { PropertyBag } from "../../../../core/properties.js";
import { BehavioralAndDriverElement } from "../and-driver.js";
import { BehavioralOrDriverElement } from "../or-driver.js";
import { BehavioralNandDriverElement } from "../nand-driver.js";
import { BehavioralNorDriverElement } from "../nor-driver.js";
import { BehavioralXorDriverElement } from "../xor-driver.js";
import { BehavioralXnorDriverElement } from "../xnor-driver.js";
import { BehavioralNotDriverElement } from "../not-driver.js";
import { BehavioralBufDriverElement } from "../buf-driver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProps(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(params)) {
    bag.setModelParam(k, v);
  }
  return bag;
}

function multiInputPinNodes(): ReadonlyMap<string, number> {
  return new Map<string, number>([
    ["In_1",    1],
    ["In_2",    2],
    ["ctrl_out", 3],
    ["gnd",     0],
  ]);
}

function singleInputPinNodes(): ReadonlyMap<string, number> {
  return new Map<string, number>([
    ["in_1",    1],
    ["ctrl_out", 2],
    ["gnd",     0],
  ]);
}

// ---------------------------------------------------------------------------
// accepts rOut/vOH/vOL via setParam without throwing
// ---------------------------------------------------------------------------

describe("gate-driver-params — accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("BehavioralAndDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ inputCount: 2, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralAndDriverElement(multiInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralOrDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ inputCount: 2, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralOrDriverElement(multiInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralNandDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ inputCount: 2, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralNandDriverElement(multiInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralNorDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ inputCount: 2, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralNorDriverElement(multiInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralXorDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ inputCount: 2, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralXorDriverElement(multiInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralXnorDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ inputCount: 2, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralXnorDriverElement(multiInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralNotDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralNotDriverElement(singleInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralBufDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralBufDriverElement(singleInputPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});
