/**
 * Lossy Transmission Line  lumped RLCG model.
 *
 * Models a transmission line as N cascaded RLCG segments. Each segment has:
 *   - Series resistance R_seg (conductor loss)
 *   - Series inductance L_seg (magnetic storage)
 *   - Shunt conductance G_seg (dielectric loss)
 *   - Shunt capacitance C_seg (electric storage)
 *
 * High-level user parameters (Zâ‚€, Ï„, loss per metre, length, segment count N)
 * are converted to per-segment RLCG values at instantiation.
 *
 * Internal topology for N segments (segments 0..N-2 have a mid-node):
 *
 *   Port1 â”€Râ”€Lâ”€ junction[0] â”€Râ”€Lâ”€ junction[1] â”€ ... â”€Râ”€Lâ”€ Port2
 *                   |                  |
 *                  G,C                G,C
 *                   |                  |
 *                  GND               GND
 *
 * Segments 0..N-2: inputNode â”€ R â”€ rlMid[k] â”€ L â”€ junction[k], shunt G+C at junction[k]
 * Segment N-1 (last): junction[N-2] â”€ CombinedRL â”€ Port2 (no shunt at Port2)
 *
 * Branch variables: N consecutive indices (one per segment inductor/CombinedRL).
 *
 * MNA stamp conventions:
 *   Inductor with nodes A, B, branch row k:
 *     B sub-matrix: G[A-1, k] += 1,  G[B-1, k] -= 1   (KCL: I_k flows AB)
 *     C sub-matrix: G[k, A-1] += ..., G[k, B-1] -= ... (KVL + companion)
 *     D sub-matrix: G[k, k] -= geq
 *     RHS[k] += ieq
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRANSMISSION_LINE_PARAM_DEFS, defaults: TRANSMISSION_LINE_DEFAULTS } = defineModelParams({
  primary: {
    impedance:    { default: 50,    description: "Characteristic impedance Zâ‚€ in ohms", min: 1 },
    delay:        { default: 1e-9,  unit: "s", description: "Total one-way propagation delay in seconds", min: 1e-15 },
  },
  secondary: {
    lossPerMeter: { default: 0,     description: "Conductor and dielectric loss in dB per metre", min: 0 },
    length:       { default: 1.0,   description: "Physical length of the transmission line in metres", min: 1e-6 },
    segments:     { default: 10,    description: "Number of lumped RLCG segments (more segments = more accurate, slower)", min: 2, max: 100 },
  },
});

// Aliases used within buildTransmissionLineNetlist
const TLINE_PARAM_DEFS = TRANSMISSION_LINE_PARAM_DEFS;
const TLINE_PARAM_DEFAULTS = TRANSMISSION_LINE_DEFAULTS;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTransmissionLinePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "P1b",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2b",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P1a",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2a",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TransmissionLineCircuitElement  CircuitElement for rendering
// ---------------------------------------------------------------------------

export class TransmissionLineCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TransmissionLine", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTransmissionLinePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 1,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");

    // Falstad TransLineElm: ladder network symbol
    // 4 zero-length thick dot lines at pin corners (fixture order: P1b, P2b, P1a, P2a)
    ctx.setLineWidth(2);
    ctx.drawLine(0, 1, 0, 1); // P1b
    ctx.drawLine(4, 1, 4, 1); // P2b
    ctx.drawLine(0, 0, 0, 0); // P1a
    ctx.drawLine(4, 0, 4, 0); // P2a

    // 32 iterations: thin vertical rung + thick horizontal top segment
    const step = 2 / 16; // 0.125 grid units (2px Ã· 16)
    for (let i = 0; i <= 31; i++) {
      const x = i * step;
      // Thin vertical rung from bottom rail to top rail
      ctx.setLineWidth(1);
      ctx.drawLine(x, 1, x, 0);
      // Thick horizontal top conductor segment
      ctx.setLineWidth(2);
      ctx.drawLine(x, 0, x + step, 0);
    }

    // Thick bottom conductor (full width)
    ctx.setLineWidth(2);
    ctx.drawLine(0, 1, 4, 1);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// buildTransmissionLineNetlist  function-form netlist (Composite M6)
// ---------------------------------------------------------------------------

/**
 * Builds the MNA subcircuit netlist for a lossy transmission line.
 *
 * Per-segment R/L/G/C derivation verbatim from
 * TransmissionLineElement constructor (transmission-line.ts:775-786).
 *
 * Ports: ["P1a", "P1b", "P2a", "P2b"] â†’ indices 0, 1, 2, 3
 * Internal nets:
 *   rlMid0..rlMid(N-2): indices 4..4+(N-2)          (N-1 nodes)
 *   junc0..junc(N-2):   indices 4+(N-1)..4+2(N-1)-1  (N-1 nodes)
 * Total internal nets: 2*(N-1)
 */
export const buildTransmissionLineNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  const N = params.getModelParam<number>("segments");
  const Z0 = params.getModelParam<number>("impedance");
  const delay = params.getModelParam<number>("delay");
  const lossDb = params.getModelParam<number>("lossPerMeter");
  const length = params.getModelParam<number>("length");

  // Per-segment R/L/G/C derivation- verbatim from
  // TransmissionLineElement constructor (transmission-line.ts:775-786).
  const lSeg = (Z0 * delay) / N;
  const cSeg = delay / (Z0 * N);
  let rSeg = 0;
  let gSeg = 0;
  if (lossDb > 0) {
    const alphaNpPerM = (lossDb * Math.LN10) / 20;
    rSeg = (2 * alphaNpPerM * Z0 * length) / N;
    gSeg = (2 * alphaNpPerM * length) / (Z0 * N);
  }

  const ports = ["P1a", "P1b", "P2a", "P2b"];
  const internalNetLabels: string[] = [];
  for (let k = 0; k < N - 1; k++) internalNetLabels.push(`rlMid${k}`);
  for (let k = 0; k < N - 1; k++) internalNetLabels.push(`junc${k}`);

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];
  for (let k = 0; k < N; k++) {
    const inputNet = (k === 0) ? 1 /* P1b */ : 4 + (N - 1) + (k - 1);
    if (k < N - 1) {
      const rlMidK = 4 + k;
      const juncK = 4 + (N - 1) + k;
      elements.push({ typeId: "TransmissionSegmentR", modelRef: "default", subElementName: `seg${k}_R`, params: { R: rSeg } });
      netlist.push([inputNet, rlMidK]);
      elements.push({ typeId: "TransmissionSegmentL", modelRef: "default", subElementName: `seg${k}_L`, branchCount: 1, params: { L: lSeg } });
      netlist.push([rlMidK, juncK]);
      if (gSeg > 0) {
        elements.push({ typeId: "TransmissionSegmentG", modelRef: "default", subElementName: `seg${k}_G`, params: { G: gSeg } });
        netlist.push([juncK]);
      }
      elements.push({ typeId: "TransmissionSegmentC", modelRef: "default", subElementName: `seg${k}_C`, params: { C: cSeg } });
      netlist.push([juncK]);
    } else {
      elements.push({ typeId: "TransmissionSegmentRL", modelRef: "default", subElementName: `seg${k}_RL`, branchCount: 1, params: { R: rSeg, L: lSeg } });
      netlist.push([inputNet, 3 /* P2b */]);
    }
  }

  // `params` is optional on MnaSubcircuitNetlist; under exactOptionalPropertyTypes
  // the field must be ABSENT (not explicitly assigned undefined) to satisfy the
  // type. Per-element type-assertion casts on each SubcircuitElement literal
  // were dropped: literals satisfy the structural type when params values are
  // plain numbers, so no widening cast is required.
  return { ports, elements, internalNetCount: 2 * (N - 1), internalNetLabels, netlist };
};

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRANSMISSION_LINE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "lossPerMeter",
    type: PropertyType.FLOAT,
    label: "Loss (dB/m)",
    defaultValue: 0,
    min: 0,
    description: "Conductor and dielectric loss in dB per metre",
  },
  {
    key: "length",
    type: PropertyType.FLOAT,
    label: "Length (m)",
    defaultValue: 1.0,
    min: 1e-6,
    description: "Physical length of the transmission line in metres",
  },
  {
    key: "segments",
    type: PropertyType.INT,
    label: "Segments (N)",
    defaultValue: 10,
    min: 2,
    max: 100,
    description: "Number of lumped RLCG segments (more segments = more accurate, slower)",
    structural: true,
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown on the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "impedance",
    propertyKey: "impedance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "delay",
    propertyKey: "delay",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "lossPerMeter",
    propertyKey: "lossPerMeter",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "length",
    propertyKey: "length",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "segments",
    propertyKey: "segments",
    modelParam: true,
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// TransmissionLineDefinition
// ---------------------------------------------------------------------------

function transmissionLineCircuitFactory(props: PropertyBag): TransmissionLineCircuitElement {
  return new TransmissionLineCircuitElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const TransmissionLineDefinition: StandaloneComponentDefinition = {
  name: "TransmissionLine",
  typeId: -1,
  factory: transmissionLineCircuitFactory,
  pinLayout: buildTransmissionLinePinDeclarations(),
  propertyDefs: TRANSMISSION_LINE_PROPERTY_DEFS,
  attributeMap: TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Lossy Transmission Line  lumped RLCG model.\n" +
    "N cascaded segments with series RL and shunt GC. " +
    "Parameterised by Zâ‚€, propagation delay, loss, and segment count.",
  models: {},
  modelRegistry: {
    "default": {
      kind: "netlist",
      netlist: buildTransmissionLineNetlist,
      paramDefs: TLINE_PARAM_DEFS,
      params: TLINE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "default",
};
