/**
 * Behavioral analog netlist builders for remaining digital components:
 *   - Driver (tri-state buffer)
 *   - DriverInvSel (inverting tri-state buffer)
 *   - Splitter / BusSplitter (pass-through per bit)
 *   - SevenSeg / SevenSegHex (7 segment display model)
 *   - ButtonLED (switch + LED indicator)
 *
 * Driver leaves are registered in src/components/register-all.ts.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import type { PropertyBag } from "../../core/properties.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Driver / DriverInvSel behavioural model parameter declarations
// ---------------------------------------------------------------------------
//
// Shared shape across both tri-state variants:
//   loaded:    1 = loaded pin sub-elements (Loaded variants), 0 = unloaded.
//   vIH/vIL:   per-input CMOS thresholds, consumed by the driver leaf's
//              threshold-classify-with-hold logic.
//   rOut/cOut: outPin's RC load (rOut feeds the Norton conductance inside
//              BehavioralOutputDriver; cOut is a separate Capacitor child).
//   vOH/vOL:   driven analog rail voltages.
//
// The `behavioural` model is strictly 1-bit (matches mux precedent). Multi-
// bit Driver/DriverInvSel circuits fall through to the digital path.

export const { paramDefs: DRIVER_BEHAVIORAL_PARAM_DEFS, defaults: DRIVER_BEHAVIORAL_DEFAULTS } = defineModelParams({
  primary: {
    loaded: { default: 1,     unit: "",  description: "1 = loaded pins (DigitalInputPinLoaded / DigitalOutputPinLoaded), 0 = unloaded" },
    vIH:    { default: 2.0,   unit: "V", description: "Input high threshold (CMOS spec)" },
    vIL:    { default: 0.8,   unit: "V", description: "Input low threshold (CMOS spec)" },
    rOut:   { default: 100,   unit: "Ω", description: "Output drive resistance (Norton conductance = 1/rOut when enabled, 1 GΩ when high-Z)" },
    cOut:   { default: 1e-12, unit: "F", description: "Output companion capacitance" },
    vOH:    { default: 5.0,   unit: "V", description: "Output high voltage" },
    vOL:    { default: 0.0,   unit: "V", description: "Output low voltage" },
  },
});

// ---------------------------------------------------------------------------
// buildDriverNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioural tri-state buffer (Driver).
 *
 * Port order: in(0), sel(1), out(2), gnd(3).
 *
 * Sub-elements:
 *   drv    - BehavioralDriverDriver (writes OUTPUT_LOGIC_LEVEL + OUTPUT_LOGIC_LEVEL_ENABLE)
 *   inPin  - Digital input pin (loaded or unloaded) on `in`
 *   selPin - Digital input pin (loaded or unloaded) on `sel`
 *   outPin - DigitalOutputPinLoaded on `out`; consumes both:
 *              inputLogic  ← drv.OUTPUT_LOGIC_LEVEL        (data passes through)
 *              enableLogic ← drv.OUTPUT_LOGIC_LEVEL_ENABLE (active-high enable)
 *            When the enable slot reads < 0.5 the inner Norton conductance
 *            collapses to 1 GΩ → high-Z; other drivers on the shared net
 *            dominate.
 */
export function buildDriverNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const loaded        = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  const ports = ["in", "sel", "out", "gnd"];

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralDriverDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {
        vIH: params.getModelParam<number>("vIH"),
        vIL: params.getModelParam<number>("vIL"),
      },
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "inPin",
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "selPin",
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: outputPinType,
      modelRef: "default",
      subElementName: "outPin",
      params: {
        rOut: params.getModelParam<number>("rOut"),
        cOut: params.getModelParam<number>("cOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
        inputLogic:  { kind: "siblingState" as const, subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL" },
        enableLogic: { kind: "siblingState" as const, subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL_ENABLE" },
      },
    } as SubcircuitElement & { subElementName: string },
  ];

  // Net indices: in=0, sel=1, out=2, gnd=3
  // drv pins: in, sel, out, gnd
  // inPin pins: node=in, gnd=gnd
  // selPin pins: node=sel, gnd=gnd
  // outPin pins: pos=out, neg=gnd
  const netlist: number[][] = [
    [0, 1, 2, 3], // drv
    [0, 3],       // inPin
    [1, 3],       // selPin
    [2, 3],       // outPin
  ];

  return {
    ports,
    elements,
    internalNetCount: 0,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildDriverInvNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioural inverting tri-state
 * buffer (DriverInvSel- active-LOW enable).
 *
 * Same port shape as Driver. The only behavioural difference is that the
 * driver leaf (BehavioralDriverInvDriver) inverts sel before writing
 * OUTPUT_LOGIC_LEVEL_ENABLE, so the outPin's enableLogic sees enable=1
 * when sel is asserted LOW.
 *
 * Port order: in(0), sel(1), out(2), gnd(3).
 */
export function buildDriverInvNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const loaded        = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  const ports = ["in", "sel", "out", "gnd"];

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralDriverInvDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {
        vIH: params.getModelParam<number>("vIH"),
        vIL: params.getModelParam<number>("vIL"),
      },
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "inPin",
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "selPin",
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: outputPinType,
      modelRef: "default",
      subElementName: "outPin",
      params: {
        rOut: params.getModelParam<number>("rOut"),
        cOut: params.getModelParam<number>("cOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
        inputLogic:  { kind: "siblingState" as const, subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL" },
        enableLogic: { kind: "siblingState" as const, subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL_ENABLE" },
      },
    } as SubcircuitElement & { subElementName: string },
  ];

  // Net indices: in=0, sel=1, out=2, gnd=3
  const netlist: number[][] = [
    [0, 1, 2, 3], // drv
    [0, 3],       // inPin
    [1, 3],       // selPin
    [2, 3],       // outPin
  ];

  return {
    ports,
    elements,
    internalNetCount: 0,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildSplitterNetlist
// ---------------------------------------------------------------------------

/**
 * Count splitter ports from a comma-separated splitting definition. Mirrors
 * the counting half of `parsePorts` in `components/wiring/splitter.ts`
 * without reaching into the components layer (solver code can't depend on
 * components by layering convention). Recognises plain widths (`"4"`),
 * repeat shorthand (`"4*2"` = two ports), and explicit ranges (`"4-7"`).
 *
 * Returns at least 1 -- matches `parsePorts`' fallback for empty input.
 */
function countSplitterPorts(definition: string): number {
  let count = 0;
  const tokens = definition.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const token of tokens) {
    const starIdx = token.indexOf("*");
    if (starIdx >= 0) {
      const repeat = parseInt(token.substring(starIdx + 1).trim(), 10);
      count += Number.isFinite(repeat) && repeat > 0 ? repeat : 1;
    } else {
      count += 1;
    }
  }
  return count > 0 ? count : 1;
}

/**
 * Function-form netlist builder for the behavioral splitter / bus-splitter.
 *
 * Port order is dynamic: input pins first (labeled `in_0..in_{N-1}`), then
 * output pins (`out_0..out_{M-1}`), then gnd. Input/output port counts are
 * derived from the parent splitter's `"input splitting"` and
 * `"output splitting"` string properties (parsed with the same convention
 * as `executeSplitter` and `inputSchema`/`outputSchema`).
 *
 * Sub-elements:
 *   drv       - BehavioralSplitterDriver (driver leaf)
 *   in_N pins - DigitalInputPinLoaded for each input
 *   out_M pins - DigitalOutputPinLoaded for each output
 *
 * Strictly 1-bit per port. Multi-bit-per-port widths (e.g., "4,4"
 * yielding two 4-bit input ports) are not yet honoured by the driver leaf
 * itself -- multi-bit bus support across analog wires is the multi-bit
 * spec round's problem.
 */
export function buildSplitterNetlist(props: PropertyBag): MnaSubcircuitNetlist {
  const inputSplitting  = props.getOrDefault<string>("input splitting", "4,4");
  const outputSplitting = props.getOrDefault<string>("output splitting", "8");
  const inputCount = countSplitterPorts(inputSplitting);
  const outputCount = countSplitterPorts(outputSplitting);

  const ports: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    ports.push(`in_${i}`);
  }
  for (let i = 0; i < outputCount; i++) {
    ports.push(`out_${i}`);
  }
  ports.push("gnd");

  const netGnd = inputCount + outputCount;

  const drvNets: number[] = [];
  for (let i = 0; i < inputCount; i++) {
    drvNets.push(i);
  }
  for (let i = 0; i < outputCount; i++) {
    drvNets.push(inputCount + i);
  }
  drvNets.push(netGnd);

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralSplitterDriver",
      modelRef: "default",
      subElementName: "drv",
      params: { inputCount, outputCount },
    } as SubcircuitElement & { subElementName: string },
  ];

  const netlist: number[][] = [drvNets];

  for (let i = 0; i < inputCount; i++) {
    elements.push({
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: `inPin_${i}`,
      params: {},
    } as SubcircuitElement & { subElementName: string });
    netlist.push([i, netGnd]);
  }

  for (let i = 0; i < outputCount; i++) {
    elements.push({
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: `outPin_${i}`,
      params: {
        inputLogic: { kind: "siblingState", subElementName: "drv", slotName: `OUTPUT_LOGIC_LEVEL_${i}` },
      },
    } as SubcircuitElement & { subElementName: string });
    netlist.push([inputCount + i, netGnd]);
  }

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 0,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildSevenSegNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioral seven-segment display.
 *
 * Port order: a(0), b(1), c(2), d(3), e(4), f(5), g(6), dp(7), gnd(8).
 *
 * Sub-elements:
 *   drv     - BehavioralSevenSegDriver (driver leaf)
 *   aPin..dpPin - DigitalInputPinLoaded for each segment input
 */
export function buildSevenSegNetlist(): MnaSubcircuitNetlist {
  const segmentLabels = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;
  const ports: string[] = [...segmentLabels, "gnd"];
  const netGnd = segmentLabels.length;

  const drvNets: number[] = segmentLabels.map((_, i) => i);
  drvNets.push(netGnd);

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralSevenSegDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {},
    } as SubcircuitElement & { subElementName: string },
  ];

  const netlist: number[][] = [drvNets];

  for (let i = 0; i < segmentLabels.length; i++) {
    elements.push({
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: `${segmentLabels[i]}Pin`,
      params: {},
    } as SubcircuitElement & { subElementName: string });
    netlist.push([i, netGnd]);
  }

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 0,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildButtonLEDNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioral ButtonLED (button output + LED input).
 *
 * Port order: out(0), in(1), gnd(2).
 *
 * Sub-elements:
 *   drv    - BehavioralButtonLEDDriver (driver leaf)
 *   inPin  - DigitalInputPinLoaded for LED in
 *   outPin - DigitalOutputPinLoaded for button out
 */
export function buildButtonLEDNetlist(): MnaSubcircuitNetlist {
  const ports = ["out", "in", "gnd"];

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralButtonLEDDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "inPin",
      params: {},
    } as SubcircuitElement & { subElementName: string },
    {
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: "outPin",
      params: {
        inputLogic: { kind: "siblingState", subElementName: "drv", slotName: "OUTPUT_LOGIC_LEVEL" },
      },
    } as SubcircuitElement & { subElementName: string },
  ];

  // Net indices: out=0, in=1, gnd=2
  // drv pins: out, in, gnd
  // inPin pins: node=in, gnd=gnd
  // outPin pins: pos=out, neg=gnd
  const netlist: number[][] = [
    [0, 1, 2], // drv
    [1, 2],    // inPin
    [0, 2],    // outPin
  ];

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 0,
    netlist,
  };
}
