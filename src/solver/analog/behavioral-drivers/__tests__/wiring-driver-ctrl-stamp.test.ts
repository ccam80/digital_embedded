/**
 * Ctrl-stamp tests for wiring driver leaves:
 *   - BehavioralMuxDriverElement     (Multiplexer: selects one of N inputs)
 *   - BehavioralDemuxDriverElement   (Demultiplexer: routes input to one of N outputs)
 *   - BehavioralDecoderDriverElement (Decoder: one-hot encode selector)
 *   - BehavioralSplitterDriverElement (Splitter: passthrough / split / merge)
 *   - BehavioralSevenSegDriverElement (Seven-segment display: 7 ctrl pins a..g)
 *
 * Each driver stamps Norton at its ctrl_* pins. After buildFixture (one warm-start
 * step), the node voltages at ctrl_* nodes reflect vOH or vOL per the driver logic.
 *
 * Tier: T1 (buildFixture, headless).
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../__tests__/fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import { BehavioralMuxDriverElement }       from "../mux-driver.js";
import { BehavioralDemuxDriverElement }     from "../demux-driver.js";
import { BehavioralDecoderDriverElement }   from "../decoder-driver.js";
import { BehavioralSplitterDriverElement }  from "../splitter-driver.js";
import { BehavioralSevenSegDriverElement }  from "../seven-seg-driver.js";
import type { AnalogElement } from "../../element.js";

const VDD = 5.0;
const GND = 0.0;
const HI  = 1.0;  // normalized {0,1} ctrl_out voltage for "high" bit
const LO  = 0.0;  // normalized {0,1} ctrl_out voltage for "low"  bit
const LOAD_R = 1_000_000;

// ---------------------------------------------------------------------------
// Generic element-class finder
// ---------------------------------------------------------------------------

type AnyDriverClass =
  | typeof BehavioralMuxDriverElement
  | typeof BehavioralDemuxDriverElement
  | typeof BehavioralDecoderDriverElement
  | typeof BehavioralSplitterDriverElement
  | typeof BehavioralSevenSegDriverElement;

function findDriverElement(
  fix: ReturnType<typeof buildFixture>,
  DriverCls: AnyDriverClass,
): AnalogElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof DriverCls) return el;
  }
  throw new Error("No " + DriverCls.name + " found in compiled circuit");
}

function getCtrlV(
  fix: ReturnType<typeof buildFixture>,
  el: AnalogElement,
  ctrlPin: string,
): number {
  const ctrlNode = el.pinNodes.get(ctrlPin);
  const gndNode  = el.pinNodes.get("gnd");
  if (ctrlNode === undefined) throw new Error(ctrlPin + " pin not found on driver");
  if (gndNode  === undefined) throw new Error("gnd pin not found on driver");
  return fix.engine.getNodeVoltage(ctrlNode) - fix.engine.getNodeVoltage(gndNode);
}

// ===========================================================================
// Mux
// ===========================================================================
//
// selectorBits=1: 2 data inputs (in_0, in_1), 1 sel bit. sel=0 routes in_0;
// sel=1 routes in_1.

function buildMuxFixture(vSel: number, vIn0: number, vIn1: number) {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsSel", type: "DcVoltageSource", props: { label: "vsSel", voltage: vSel } },
          { id: "vsIn0", type: "DcVoltageSource", props: { label: "vsIn0", voltage: vIn0 } },
          { id: "vsIn1", type: "DcVoltageSource", props: { label: "vsIn1", voltage: vIn1 } },
          { id: "mux",   type: "Multiplexer",     props: { label: "mux", model: "behavioral", selectorBits: 1 } },
          { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",  "mux:sel"],
          ["vsIn0:pos",  "mux:in_0"],
          ["vsIn1:pos",  "mux:in_1"],
          ["mux:out",    "rLoad:pos"],
          ["rLoad:neg",  "gnd:out"],
          ["vsSel:neg",  "gnd:out"],
          ["vsIn0:neg",  "gnd:out"],
          ["vsIn1:neg",  "gnd:out"],
        ],
      }),
  });
}

describe("BehavioralMuxDriver ctrl_out stamp (Cat 2 DCOP)", () => {
  it("selects in_0 (VDD) when sel=GND, stamps vOH at ctrl_out", () => {
    const fix = buildMuxFixture(GND, VDD, GND);
    const el = findDriverElement(fix, BehavioralMuxDriverElement);
    expect(getCtrlV(fix, el, "ctrl_out")).toBeCloseTo(HI, 4);
  });

  it("selects in_1 (GND) when sel=VDD, stamps vOL at ctrl_out", () => {
    const fix = buildMuxFixture(VDD, VDD, GND);
    const el = findDriverElement(fix, BehavioralMuxDriverElement);
    expect(getCtrlV(fix, el, "ctrl_out")).toBeCloseTo(LO, 4);
  });

  it("selects in_0 (GND) when sel=GND, stamps vOL at ctrl_out", () => {
    const fix = buildMuxFixture(GND, GND, VDD);
    const el = findDriverElement(fix, BehavioralMuxDriverElement);
    expect(getCtrlV(fix, el, "ctrl_out")).toBeCloseTo(LO, 4);
  });
});

// ===========================================================================
// Demux
// ===========================================================================
//
// selectorBits=1: 1 data input, 2 outputs. sel=0 routes data to out_0;
// sel=1 routes data to out_1. Unselected outputs stamp vOL.

function buildDemuxFixture(vSel: number, vIn: number) {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsSel", type: "DcVoltageSource", props: { label: "vsSel", voltage: vSel } },
          { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn",  voltage: vIn  } },
          { id: "demux", type: "Demultiplexer",   props: { label: "demux", model: "behavioral", selectorBits: 1 } },
          { id: "r0",    type: "Resistor",        props: { label: "r0", resistance: LOAD_R } },
          { id: "r1",    type: "Resistor",        props: { label: "r1", resistance: LOAD_R } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",   "demux:sel"],
          ["vsIn:pos",    "demux:in"],
          ["demux:out_0", "r0:pos"],
          ["demux:out_1", "r1:pos"],
          ["r0:neg",      "gnd:out"],
          ["r1:neg",      "gnd:out"],
          ["vsSel:neg",   "gnd:out"],
          ["vsIn:neg",    "gnd:out"],
        ],
      }),
  });
}

describe("BehavioralDemuxDriver ctrl_* stamp (Cat 2 DCOP)", () => {
  it("sel=GND, in=VDD: stamps vOH at ctrl_0 and vOL at ctrl_1", () => {
    const fix = buildDemuxFixture(GND, VDD);
    const el = findDriverElement(fix, BehavioralDemuxDriverElement);
    expect(getCtrlV(fix, el, "ctrl_0")).toBeCloseTo(HI, 4);
    expect(getCtrlV(fix, el, "ctrl_1")).toBeCloseTo(LO, 4);
  });

  it("sel=VDD, in=VDD: stamps vOL at ctrl_0 and vOH at ctrl_1", () => {
    const fix = buildDemuxFixture(VDD, VDD);
    const el = findDriverElement(fix, BehavioralDemuxDriverElement);
    expect(getCtrlV(fix, el, "ctrl_0")).toBeCloseTo(LO, 4);
    expect(getCtrlV(fix, el, "ctrl_1")).toBeCloseTo(HI, 4);
  });

  it("sel=GND, in=GND: stamps vOL at both ctrl_0 and ctrl_1", () => {
    const fix = buildDemuxFixture(GND, GND);
    const el = findDriverElement(fix, BehavioralDemuxDriverElement);
    expect(getCtrlV(fix, el, "ctrl_0")).toBeCloseTo(LO, 4);
    expect(getCtrlV(fix, el, "ctrl_1")).toBeCloseTo(LO, 4);
  });
});

// ===========================================================================
// Decoder
// ===========================================================================
//
// selectorBits=1: 2 outputs. sel=0 sets out_0=high, out_1=low;
// sel=1 sets out_0=low, out_1=high.

function buildDecoderFixture(vSel: number) {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsSel",   type: "DcVoltageSource", props: { label: "vsSel", voltage: vSel } },
          { id: "decoder", type: "Decoder",         props: { label: "decoder", model: "behavioral", selectorBits: 1 } },
          { id: "r0",      type: "Resistor",        props: { label: "r0", resistance: LOAD_R } },
          { id: "r1",      type: "Resistor",        props: { label: "r1", resistance: LOAD_R } },
          { id: "gnd",     type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",     "decoder:sel"],
          ["decoder:out_0", "r0:pos"],
          ["decoder:out_1", "r1:pos"],
          ["r0:neg",        "gnd:out"],
          ["r1:neg",        "gnd:out"],
          ["vsSel:neg",     "gnd:out"],
        ],
      }),
  });
}

describe("BehavioralDecoderDriver ctrl_* stamp (Cat 2 DCOP)", () => {
  it("sel=GND: stamps vOH at ctrl_0 and vOL at ctrl_1", () => {
    const fix = buildDecoderFixture(GND);
    const el = findDriverElement(fix, BehavioralDecoderDriverElement);
    expect(getCtrlV(fix, el, "ctrl_0")).toBeCloseTo(HI, 4);
    expect(getCtrlV(fix, el, "ctrl_1")).toBeCloseTo(LO, 4);
  });

  it("sel=VDD: stamps vOL at ctrl_0 and vOH at ctrl_1", () => {
    const fix = buildDecoderFixture(VDD);
    const el = findDriverElement(fix, BehavioralDecoderDriverElement);
    expect(getCtrlV(fix, el, "ctrl_0")).toBeCloseTo(LO, 4);
    expect(getCtrlV(fix, el, "ctrl_1")).toBeCloseTo(HI, 4);
  });
});

// ===========================================================================
// Splitter
// ===========================================================================
//
// Splitter pin labels are derived from portName() (e.g. "0", "1") not "in_0".
// Use inputSplitting:"1,1" (two 1-bit inputs, labels "0" and "1") and
// outputSplitting:"2" (one 2-bit output, label "0-1") to avoid naming clashes
// and exercise the merge-mode code path in BehavioralSplitterDriverElement.
// The merge output packs bit 0 from in_0 and bit 1 from in_1; ctrl_0 is the
// single merged output ctrl net.

function buildSplitterFixture(vIn0: number, vIn1: number) {
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "vsIn0", type: "DcVoltageSource", props: { label: "vsIn0", voltage: vIn0 } },
          { id: "vsIn1", type: "DcVoltageSource", props: { label: "vsIn1", voltage: vIn1 } },
          { id: "spl",   type: "Splitter",        props: { label: "spl", model: "behavioral", inputSplitting: "1,1", outputSplitting: "2" } },
          { id: "rOut",  type: "Resistor",        props: { label: "rOut", resistance: LOAD_R } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsIn0:pos",  "spl:0"],
          ["vsIn1:pos",  "spl:1"],
          ["spl:0,1",    "rOut:pos"],
          ["rOut:neg",   "gnd:out"],
          ["vsIn0:neg",  "gnd:out"],
          ["vsIn1:neg",  "gnd:out"],
        ],
      }),
  });
}

describe("BehavioralSplitterDriver ctrl_* stamp (Cat 2 DCOP)", () => {
  it("merge mode: in_0=VDD, in_1=GND stamps vOH at ctrl_0 (packed bits non-zero)", () => {
    const fix = buildSplitterFixture(VDD, GND);
    const el = findDriverElement(fix, BehavioralSplitterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_0")).toBeCloseTo(HI, 4);
  });

  it("merge mode: in_0=GND, in_1=GND stamps vOL at ctrl_0 (packed bits zero)", () => {
    const fix = buildSplitterFixture(GND, GND);
    const el = findDriverElement(fix, BehavioralSplitterDriverElement);
    expect(getCtrlV(fix, el, "ctrl_0")).toBeCloseTo(LO, 4);
  });
});

// ===========================================================================
// Seven-Segment Display
// ===========================================================================
//
// Drive select segments high and verify ctrl_* stamps vOH at those pins,
// vOL at the others. Digit "1" pattern: b and c high, all others low.

function buildSevenSegFixture(segVoltages: Record<string, number>) {
  const segs = ["a", "b", "c", "d", "e", "f", "g", "dp"];
  return buildFixture({
    build: (_r: ComponentRegistry, facade: DefaultSimulatorFacade) =>
      facade.build({
        components: [
          { id: "seg",  type: "SevenSeg",        props: { label: "seg", model: "behavioral" } },
          ...segs.map(s => ({
            id: `vs${s.toUpperCase()}`,
            type: "DcVoltageSource",
            props: { label: `vs${s.toUpperCase()}`, voltage: segVoltages[s] ?? GND },
          })),
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ...segs.map(s => [`vs${s.toUpperCase()}:pos`, `seg:${s}`] as [string, string]),
          ...segs.map(s => [`vs${s.toUpperCase()}:neg`, "gnd:out"] as [string, string]),
        ],
      }),
  });
}

describe("BehavioralSevenSegDriver ctrl_* stamp (Cat 2 DCOP)", () => {
  it("digit 1 pattern (b=c=VDD, rest=GND): stamps vOH at ctrl_b and ctrl_c, vOL at ctrl_a/d/e/f/g", () => {
    const fix = buildSevenSegFixture({ a: GND, b: VDD, c: VDD, d: GND, e: GND, f: GND, g: GND, dp: GND });
    const el = findDriverElement(fix, BehavioralSevenSegDriverElement);
    expect(getCtrlV(fix, el, "ctrl_a")).toBeCloseTo(LO, 4);
    expect(getCtrlV(fix, el, "ctrl_b")).toBeCloseTo(HI, 4);
    expect(getCtrlV(fix, el, "ctrl_c")).toBeCloseTo(HI, 4);
    expect(getCtrlV(fix, el, "ctrl_d")).toBeCloseTo(LO, 4);
    expect(getCtrlV(fix, el, "ctrl_e")).toBeCloseTo(LO, 4);
    expect(getCtrlV(fix, el, "ctrl_f")).toBeCloseTo(LO, 4);
    expect(getCtrlV(fix, el, "ctrl_g")).toBeCloseTo(LO, 4);
  });

  it("all segments high: stamps vOH at all ctrl_a..ctrl_g", () => {
    const fix = buildSevenSegFixture({ a: VDD, b: VDD, c: VDD, d: VDD, e: VDD, f: VDD, g: VDD, dp: GND });
    const el = findDriverElement(fix, BehavioralSevenSegDriverElement);
    for (const seg of ["a", "b", "c", "d", "e", "f", "g"]) {
      expect(getCtrlV(fix, el, `ctrl_${seg}`)).toBeCloseTo(HI, 4);
    }
  });

  it("all segments low: stamps vOL at all ctrl_a..ctrl_g", () => {
    const fix = buildSevenSegFixture({ a: GND, b: GND, c: GND, d: GND, e: GND, f: GND, g: GND, dp: GND });
    const el = findDriverElement(fix, BehavioralSevenSegDriverElement);
    for (const seg of ["a", "b", "c", "d", "e", "f", "g"]) {
      expect(getCtrlV(fix, el, `ctrl_${seg}`)).toBeCloseTo(LO, 4);
    }
  });
});
