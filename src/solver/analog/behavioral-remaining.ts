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
 * Internal nets: ctrl_out(4), ctrl_en(5).
 *
 * Sub-elements:
 *   drv    - BehavioralDriverDriver (stamps Norton at ctrl_out and ctrl_en).
 *   inPin  - Digital input pin (loaded or unloaded) on `in`
 *   selPin - Digital input pin (loaded or unloaded) on `sel`
 *   outPin - DigitalOutputPinTriStateLoaded on `out` (4-port: node, gnd, ctrl, en).
 */
export function buildDriverNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const loaded       = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType = loaded ? "DigitalInputPinLoaded" : "DigitalInputPinUnloaded";

  const ports = ["in", "sel", "out", "gnd"];

  // Ports: in=0, sel=1, out=2, gnd=3. Internal: ctrl_out=4, ctrl_en=5.
  const ctrlOutNet = 4;
  const ctrlEnNet  = 5;

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralDriverDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {
        rOut: params.getModelParam<number>("rOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
      },
    },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "inPin",
    },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "selPin",
    },
    {
      typeId: "DigitalOutputPinTriStateLoaded",
      modelRef: "default",
      subElementName: "outPin",
      params: {
        rOut: params.getModelParam<number>("rOut"),
        cOut: params.getModelParam<number>("cOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
      },
    },
  ];

  // drv pin order: in, sel, ctrl_out, ctrl_en, gnd => [0, 1, 4, 5, 3]
  // inPin:  [node=in, gnd=gnd]    => [0, 3]
  // selPin: [node=sel, gnd=gnd]   => [1, 3]
  // outPin: [node=out, gnd=gnd, ctrl=ctrl_out, en=ctrl_en] => [2, 3, 4, 5]
  const netlist: number[][] = [
    [0, 1, ctrlOutNet, ctrlEnNet, 3], // drv
    [0, 3],                           // inPin
    [1, 3],                           // selPin
    [2, 3, ctrlOutNet, ctrlEnNet],    // outPin
  ];

  return {
    ports,
    elements,
    internalNetCount: 2,
    internalNetLabels: ["ctrl_out", "ctrl_en"],
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildDriverInvNetlist
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the behavioural inverting tri-state buffer (DriverInvSel).
 *
 * Port order: in(0), sel(1), out(2), gnd(3).
 * Internal nets: ctrl_out(4), ctrl_en(5).
 *
 * The driver leaf inverts sel internally so ctrl_en is HIGH when sel is LOW
 * (active-LOW enable). The outPin DigitalOutputPinTriStateLoaded sees
 * enable=1 when sel is asserted LOW.
 *
 * Sub-elements:
 *   drv    - BehavioralDriverInvDriver (stamps Norton at ctrl_out and ctrl_en).
 *   inPin  - Digital input pin (loaded or unloaded) on `in`
 *   selPin - Digital input pin (loaded or unloaded) on `sel`
 *   outPin - DigitalOutputPinTriStateLoaded on `out` (4-port: node, gnd, ctrl, en).
 */
export function buildDriverInvNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const loaded       = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType = loaded ? "DigitalInputPinLoaded" : "DigitalInputPinUnloaded";

  const ports = ["in", "sel", "out", "gnd"];

  // Ports: in=0, sel=1, out=2, gnd=3. Internal: ctrl_out=4, ctrl_en=5.
  const ctrlOutNet = 4;
  const ctrlEnNet  = 5;

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralDriverInvDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {
        rOut: params.getModelParam<number>("rOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
      },
    },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "inPin",
    },
    {
      typeId: inputPinType,
      modelRef: "default",
      subElementName: "selPin",
    },
    {
      typeId: "DigitalOutputPinTriStateLoaded",
      modelRef: "default",
      subElementName: "outPin",
      params: {
        rOut: params.getModelParam<number>("rOut"),
        cOut: params.getModelParam<number>("cOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
      },
    },
  ];

  // drv pin order: in, sel, ctrl_out, ctrl_en, gnd => [0, 1, 4, 5, 3]
  // inPin:  [node=in, gnd=gnd]    => [0, 3]
  // selPin: [node=sel, gnd=gnd]   => [1, 3]
  // outPin: [node=out, gnd=gnd, ctrl=ctrl_out, en=ctrl_en] => [2, 3, 4, 5]
  const netlist: number[][] = [
    [0, 1, ctrlOutNet, ctrlEnNet, 3], // drv
    [0, 3],                           // inPin
    [1, 3],                           // selPin
    [2, 3, ctrlOutNet, ctrlEnNet],    // outPin
  ];

  return {
    ports,
    elements,
    internalNetCount: 2,
    internalNetLabels: ["ctrl_out", "ctrl_en"],
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildSplitterNetlist
// ---------------------------------------------------------------------------

/**
 * Minimal port descriptor: bit position, width, and user-visible label.
 * Mirrors `SplitterPort` in `components/wiring/splitter.ts` without importing
 * from the components layer (solver code must not depend on components by
 * layering convention).
 */
interface SplitterPortDesc {
  pos: number;
  bits: number;
  name: string;
}

/**
 * Compute user-visible pin label for a splitter port.
 * Mirrors `portName()` in `components/wiring/splitter.ts` exactly.
 */
function splitterPortName(pos: number, bits: number): string {
  if (bits === 1) return `${pos}`;
  if (bits === 2) return `${pos},${pos + 1}`;
  return `${pos}-${pos + bits - 1}`;
}

/**
 * Parse a comma-separated splitting definition into an ordered list of port
 * descriptors. Mirrors the full `parsePorts` function from
 * `components/wiring/splitter.ts` without importing from the components layer.
 * Recognises plain widths (`"4"`), repeat shorthand (`"4*2"`), and explicit
 * ranges (`"4-7"`). Returns at least one 1-bit port on empty input.
 */
function parseSplitterPortNames(definition: string): SplitterPortDesc[] {
  const ports: SplitterPortDesc[] = [];
  let runningPos = 0;
  const tokens = definition.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const token of tokens) {
    const starIdx = token.indexOf("*");
    if (starIdx >= 0) {
      const bits = parseInt(token.substring(0, starIdx).trim(), 10);
      const count = parseInt(token.substring(starIdx + 1).trim(), 10);
      for (let i = 0; i < count; i++) {
        ports.push({ pos: runningPos, bits, name: splitterPortName(runningPos, bits) });
        runningPos += bits;
      }
    } else {
      const dashIdx = token.indexOf("-");
      if (dashIdx >= 0) {
        let from = parseInt(token.substring(0, dashIdx).trim(), 10);
        let to = parseInt(token.substring(dashIdx + 1).trim(), 10);
        if (to < from) { const z = to; to = from; from = z; }
        const bits = to - from + 1;
        ports.push({ pos: from, bits, name: splitterPortName(from, bits) });
        runningPos = from + bits;
      } else {
        const bits = parseInt(token, 10);
        ports.push({ pos: runningPos, bits, name: splitterPortName(runningPos, bits) });
        runningPos += bits;
      }
    }
  }
  if (ports.length === 0) {
    ports.push({ pos: 0, bits: 1, name: "0" });
  }
  return ports;
}

/**
 * Function-form netlist builder for the behavioral splitter / bus-splitter.
 *
 * Port order is dynamic: input pins first (labeled `in_0..in_{N-1}`), then
 * output pins (`out_0..out_{M-1}`), then gnd. Input/output port counts are
 * derived from the parent splitter's `"inputSplitting"` and
 * `"outputSplitting"` string properties (parsed with the same convention
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
  const inputSplitting  = props.getOrDefault<string>("inputSplitting", "4,4");
  const outputSplitting = props.getOrDefault<string>("outputSplitting", "8");
  const inputPorts  = parseSplitterPortNames(inputSplitting);
  const outputPorts = parseSplitterPortNames(outputSplitting);
  const inputCount  = inputPorts.length;
  const outputCount = outputPorts.length;

  // Port names MUST match the Splitter component's user-visible pin labels
  // (derived from portName() in splitter.ts). The compiler resolves netlist
  // ports by looking up outerPinNodes.get(portLabel), where outerPinNodes is
  // built from the component's getPins() labels.
  const ports: string[] = [
    ...inputPorts.map(p => p.name),
    ...outputPorts.map(p => p.name),
    "gnd",
  ];

  const netGnd = inputCount + outputCount;

  // Internal ctrl nets: ctrl_0..ctrl_{outputCount-1} land after all ports.
  const ctrlNetBase = inputCount + outputCount + 1;
  const internalNetLabels: string[] = [];
  for (let i = 0; i < outputCount; i++) internalNetLabels.push(`ctrl_${i}`);

  // Driver leaf pin order MUST match buildSplitterDriverPinLayout:
  // in_0..in_{N-1}, gnd, ctrl_0..ctrl_{M-1}
  const drvNets: number[] = [];
  for (let i = 0; i < inputCount; i++) {
    drvNets.push(i);
  }
  drvNets.push(netGnd);
  for (let i = 0; i < outputCount; i++) {
    drvNets.push(ctrlNetBase + i);
  }

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralSplitterDriver",
      modelRef: "default",
      subElementName: "drv",
      params: { inputCount, outputCount },
    },
  ];

  const netlist: number[][] = [drvNets];

  for (let i = 0; i < inputCount; i++) {
    elements.push({
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: `inPin_${i}`,
      params: {},
    });
    netlist.push([i, netGnd]);
  }

  for (let i = 0; i < outputCount; i++) {
    elements.push({
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: `outPin_${i}`,
      params: {},
    });
    netlist.push([inputCount + i, netGnd, ctrlNetBase + i]);
  }

  return {
    ports,
    params: {},
    elements,
    internalNetCount: outputCount,
    internalNetLabels,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// buildSevenSegNetlist
// ---------------------------------------------------------------------------

export const { paramDefs: SEVEN_SEG_BEHAVIORAL_PARAM_DEFS, defaults: SEVEN_SEG_BEHAVIORAL_DEFAULTS } = defineModelParams({
  primary: {
    vIH:  { default: 2.0,  unit: "V", description: "Input high threshold" },
    vIL:  { default: 0.8,  unit: "V", description: "Input low threshold" },
    rOut: { default: 100,  unit: "Ω", description: "Output drive resistance" },
    vOH:  { default: 5.0,  unit: "V", description: "Output high voltage" },
    vOL:  { default: 0.0,  unit: "V", description: "Output low voltage" },
  },
});

/**
 * Function-form netlist builder for the behavioral seven-segment display.
 *
 * Port order: a(0), b(1), c(2), d(3), e(4), f(5), g(6), dp(7), gnd(8).
 *
 * Sub-elements:
 *   drv     - BehavioralSevenSegDriver (driver leaf)
 *   aPin..dpPin - DigitalInputPinLoaded for each segment input
 */
export function buildSevenSegNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const segmentLabels = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;
  const drivenSegments = ["a", "b", "c", "d", "e", "f", "g"] as const;
  const ports: string[] = [...segmentLabels, "gnd"];
  const netGnd = segmentLabels.length;

  // Internal ctrl nets for the 7 driven segments (a..g, not dp).
  // ctrl_a = netGnd+1, ctrl_b = netGnd+2, ..., ctrl_g = netGnd+7.
  const ctrlNetBase = netGnd + 1;
  const internalNetLabels: string[] = drivenSegments.map(s => `ctrl_${s}`);

  // Driver leaf pin order MUST match SEVEN_SEG_DRIVER_PIN_LAYOUT:
  // a, b, c, d, e, f, g, dp, gnd, ctrl_a, ctrl_b, ctrl_c, ctrl_d, ctrl_e, ctrl_f, ctrl_g
  const drvNets: number[] = segmentLabels.map((_, i) => i);
  drvNets.push(netGnd);
  for (let i = 0; i < drivenSegments.length; i++) {
    drvNets.push(ctrlNetBase + i);
  }

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralSevenSegDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {
        vIH:  params.getModelParam<number>("vIH"),
        vIL:  params.getModelParam<number>("vIL"),
        rOut: params.getModelParam<number>("rOut"),
        vOH:  params.getModelParam<number>("vOH"),
        vOL:  params.getModelParam<number>("vOL"),
      },
    },
  ];

  const netlist: number[][] = [drvNets];

  for (let i = 0; i < segmentLabels.length; i++) {
    elements.push({
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: `${segmentLabels[i]}Pin`,
      params: {},
    });
    netlist.push([i, netGnd]);
  }

  // Output pins for the 7 driven segments (a..g).
  for (let i = 0; i < drivenSegments.length; i++) {
    const seg = drivenSegments[i];
    const outPortIdx = segmentLabels.indexOf(seg as typeof segmentLabels[number]);
    elements.push({
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: `outPin_${seg}`,
      params: {},
    });
    netlist.push([outPortIdx, netGnd, ctrlNetBase + i]);
  }

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 7,
    internalNetLabels,
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
 * Internal nets: ctrl_out(3).
 *
 * Sub-elements:
 *   drv    - BehavioralButtonLEDDriver (driver leaf; stamps Norton at ctrl_out)
 *   inPin  - DigitalInputPinLoaded for LED in
 *   outPin - DigitalOutputPinLoaded for button out (3-port: node, gnd, ctrl)
 */
export function buildButtonLEDNetlist(): MnaSubcircuitNetlist {
  const ports = ["out", "in", "gnd"];

  // Ports: out=0, in=1, gnd=2. Internal: ctrl_out=3.
  const ctrlOutNet = 3;

  const elements: SubcircuitElement[] = [
    {
      typeId: "BehavioralButtonLEDDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {},
    },
    {
      typeId: "DigitalInputPinLoaded",
      modelRef: "default",
      subElementName: "inPin",
      params: {},
    },
    {
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: "outPin",
      params: {},
    },
  ];

  // drv pin order: ctrl_out, in, gnd => [3, 1, 2]
  // inPin:  [node=in, gnd=gnd]       => [1, 2]
  // outPin: [node=out, gnd=gnd, ctrl=ctrl_out] => [0, 2, 3]
  const netlist: number[][] = [
    [ctrlOutNet, 1, 2], // drv: ctrl_out, in, gnd
    [1, 2],             // inPin
    [0, 2, ctrlOutNet], // outPin
  ];

  return {
    ports,
    params: {},
    elements,
    internalNetCount: 1,
    internalNetLabels: ["ctrl_out"],
    netlist,
  };
}
