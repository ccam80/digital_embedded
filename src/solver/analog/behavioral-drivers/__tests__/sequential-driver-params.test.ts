import { describe, it, expect } from "vitest";
import { PropertyBag } from "../../../../core/properties.js";
import { BehavioralDFlipflopDriverElement } from "../d-flipflop-driver.js";
import { BehavioralJKFlipflopDriverElement } from "../jk-flipflop-driver.js";
import { BehavioralRSFlipflopDriverElement } from "../rs-flipflop-driver.js";
import { BehavioralDAsyncFlipflopDriverElement } from "../d-async-flipflop-driver.js";
import { BehavioralJKAsyncFlipflopDriverElement } from "../jk-async-flipflop-driver.js";
import { BehavioralRSAsyncLatchDriverElement } from "../rs-async-latch-driver.js";

// ===========================================================================
// setParam — rOut / vOH / vOL hot-loadability (Phase 1 param declaration)
// ===========================================================================

describe("BehavioralDFlipflopDriver accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("rOut", 100);
    props.setModelParam("vOH", 5);
    props.setModelParam("vOL", 0);
    const pinNodes = new Map<string, number>([
      ["D", 1], ["C", 2], ["ctrl_q", 3], ["ctrl_nq", 4], ["gnd", 0],
    ]);
    const el = new BehavioralDFlipflopDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

describe("BehavioralJKFlipflopDriver accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("rOut", 100);
    props.setModelParam("vOH", 5);
    props.setModelParam("vOL", 0);
    const pinNodes = new Map<string, number>([
      ["J", 1], ["C", 2], ["K", 3], ["ctrl_q", 4], ["ctrl_nq", 5], ["gnd", 0],
    ]);
    const el = new BehavioralJKFlipflopDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

describe("BehavioralRSFlipflopDriver accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("rOut", 100);
    props.setModelParam("vOH", 5);
    props.setModelParam("vOL", 0);
    const pinNodes = new Map<string, number>([
      ["S", 1], ["C", 2], ["R", 3], ["ctrl_q", 4], ["ctrl_nq", 5], ["gnd", 0],
    ]);
    const el = new BehavioralRSFlipflopDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

describe("BehavioralDAsyncFlipflopDriver accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("rOut", 100);
    props.setModelParam("vOH", 5);
    props.setModelParam("vOL", 0);
    const pinNodes = new Map<string, number>([
      ["Set", 1], ["D", 2], ["C", 3], ["Clr", 4], ["ctrl_q", 5], ["ctrl_nq", 6], ["gnd", 0],
    ]);
    const el = new BehavioralDAsyncFlipflopDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

describe("BehavioralJKAsyncFlipflopDriver accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("rOut", 100);
    props.setModelParam("vOH", 5);
    props.setModelParam("vOL", 0);
    const pinNodes = new Map<string, number>([
      ["Set", 1], ["J", 2], ["C", 3], ["K", 4], ["Clr", 5], ["ctrl_q", 6], ["ctrl_nq", 7], ["gnd", 0],
    ]);
    const el = new BehavioralJKAsyncFlipflopDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

describe("BehavioralRSAsyncLatchDriver accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL via setParam without throwing", () => {
    const props = new PropertyBag();
    props.setModelParam("vOL", 0);
    props.setModelParam("rOut", 100);
    props.setModelParam("vOH", 5);
    const pinNodes = new Map<string, number>([
      ["S", 1], ["R", 2], ["ctrl_q", 3], ["ctrl_nq", 4], ["gnd", 0],
    ]);
    const el = new BehavioralRSAsyncLatchDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});
