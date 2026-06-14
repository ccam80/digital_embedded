/**
 * Real Op-Amp composite model.
 *
 * Extends the ideal op-amp with physically realistic effects:
 *   - Finite open-loop gain (A_OL)
 *   - Finite gain-bandwidth product (GBW)  single-pole first-order rolloff
 *   - Input offset voltage (V_os)
 *   - Input bias current (I_bias) at both inputs
 *   - Input resistance (R_in)
 *   - Slew rate limiting (clamped integrator)
 *   - Output resistance (R_out)
 *   - Output current limiting (|I_out| ≤ I_max)
 *   - Rail saturation (output clamps to V_supply ± V_sat) via railLim
 *
 * State is held entirely in StatePool slots (REAL_OPAMP_SCHEMA, 8 slots) per
 * the class is a PoolBackedAnalogElement. There is no `accept()` method-
 * the bottom-of-load() history write idiom (ngspice CKTstate0,
 * dioload.c:325-326, bjtload.c:744-746) handles slot promotion via StatePool
 * rotation.
 *
 * The post-init rail-limit block uses the ngspice MODEINIT* gate
 * (dioload.c:139-205): railLim is only invoked when none of the init bits
 * (MODEINITSMSIG, MODEINITTRAN, MODEINITJCT, MODEINITFIX, MODEINITPRED) are
 * set. When railLim clips, ctx.noncon is incremented and a
 * LimitingEvent { limitType: "railLim" } is pushed to the limitingCollector.
 *
 * .MODEL support:
 *   Standard op-amp models (741, LM358, TL072, OPA2134) are pre-defined.
 *   Keys in the model params record:
 *     A     open-loop gain (default 100000)
 *     GBW   gain-bandwidth product in Hz (default 1e6)
 *     SR    slew rate in V/s (default 0.5e6)
 *     Vos   input offset voltage in V (default 1e-3)
 *     Ibias  input bias current in A (default 80e-9)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Built-in op-amp model presets
// ---------------------------------------------------------------------------

/** Pre-defined op-amp parameter presets keyed by model name. */
export const REAL_OPAMP_MODELS: Record<string, {
  aol: number;
  gbw: number;
  slewRate: number;
  vos: number;
  iBias: number;
  rIn: number;
  rOut: number;
  iMax: number;
  vSatPos: number;
  vSatNeg: number;
}> = {
  "741": {
    aol: 200000,
    gbw: 1e6,
    slewRate: 0.5e6,
    vos: 2e-3,
    iBias: 80e-9,
    rIn: 2e6,
    rOut: 75,
    iMax: 25e-3,
    vSatPos: 2.0,
    vSatNeg: 2.0,
  },
  "LM358": {
    aol: 100000,
    gbw: 1e6,
    slewRate: 0.3e6,
    vos: 2e-3,
    iBias: 45e-9,
    rIn: 2e6,
    rOut: 75,
    iMax: 30e-3,
    vSatPos: 2.0,
    vSatNeg: 0.05,
  },
  "TL072": {
    aol: 200000,
    gbw: 3e6,
    slewRate: 13e6,
    vos: 3e-3,
    iBias: 30e-12,
    rIn: 1e12,
    rOut: 75,
    iMax: 10e-3,
    vSatPos: 1.5,
    vSatNeg: 1.5,
  },
  "OPA2134": {
    aol: 1e6,
    gbw: 8e6,
    slewRate: 20e6,
    vos: 500e-6,
    iBias: 5e-12,
    rIn: 1e13,
    rOut: 40,
    iMax: 40e-3,
    vSatPos: 1.0,
    vSatNeg: 1.0,
  },
};

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: REAL_OPAMP_PARAM_DEFS, defaults: REAL_OPAMP_DEFAULTS } = defineModelParams({
  primary: {
    aol:      { default: 100000, description: "Open-loop DC voltage gain" },
    gbw:      { default: 1e6,    unit: "Hz", description: "Gain-bandwidth product" },
    slewRate: { default: 0.5e6, unit: "V/s", description: "Slew rate" },
    vos:      { default: 1e-3,  unit: "V",   description: "Input offset voltage" },
    iBias:    { default: 80e-9, unit: "A",   description: "Input bias current" },
  },
  secondary: {
    rIn:      { default: 2e6,   unit: "Ω",   description: "Input resistance" },
    cIn:      { default: 1.4e-12, unit: "F", description: "Differential input capacitance" },
    rOut:     { default: 75,    unit: "Ω",   description: "Output resistance" },
    iMax:     { default: 25e-3, unit: "A",   description: "Output current limit" },
    vSatPos:  { default: 1.5,   unit: "V",   description: "Positive rail saturation drop" },
    vSatNeg:  { default: 1.5,   unit: "V",   description: "Negative rail saturation drop" },
  },
});

// ---------------------------------------------------------------------------
// buildRealOpAmpNetlist- modular behavioral macromodel (Brinson, Qucs OP-AMP
// tutorial). Canonical-primitive subcircuit; emits 1:1 as an ngspice deck.
//
// Block chain: input (rD/cD/iBias) -> slew clamp -> GMP1 transconductance into
// the dominant-pole node npole1 (rAdo=aol, cP1=1/2pi.gbw) with vos as an input-
// referred current -> behavioral rail clamp + output current limit (both pull
// npole1 back) -> unity VCVS output buffer -> rOut.
//
// Port net indices: in+=0, in-=1, out=2, Vcc+=3, Vcc-=4, gnd=5 (auto-resolves
// to node 0). Internal nets: nslew=6, npole1=7, nbuf=8.
// ---------------------------------------------------------------------------

export const buildRealOpAmpNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  const aol     = params.getModelParam<number>("aol");
  const gbw     = params.getModelParam<number>("gbw");
  const vos     = params.getModelParam<number>("vos");
  const iBias   = params.getModelParam<number>("iBias");
  const rIn     = params.getModelParam<number>("rIn");
  const cIn     = params.getModelParam<number>("cIn");
  const rOut    = params.getModelParam<number>("rOut");
  const vSatPos = params.getModelParam<number>("vSatPos");
  const vSatNeg = params.getModelParam<number>("vSatNeg");
  const slewRate = params.getModelParam<number>("slewRate");
  const iMax    = params.getModelParam<number>("iMax");

  // Dominant-pole capacitance: f_p1 = 1/(2.pi.RADO.CP1) and Aol(DC)=RADO with
  // GMP1=1 S give the unity-gain bandwidth gbw = GMP1/(2.pi.CP1) (Qucs eq 3).
  const cP1 = 1 / (2 * Math.PI * Math.max(gbw, 1));

  // Gain stage with slew (Verilog-A reference eq 14-16): the differential-pair
  // transfer srp*tanh((vd+vos)/srp) injects current straight into npole1. tanh is
  // slope 1 at the origin (small-signal gm=1, so DC gain = RADO=aol) saturating to
  // srp = SR*CP1, bounding the current charging CP1 - hence dV/dt at npole1 - at
  // the slew rate. vos is the input-referred offset (Fig 8 Voff). A single BI into
  // the high-gain node converges directly (no intermediate Norton node in-path).
  const srp = slewRate / (2 * Math.PI * Math.max(gbw, 1));
  const gmSlewExpr = `${srp}*tanh((V(p)-V(n)+${vos})/${srp})`;

  // Voltage limiter (rail clamp): behavioral pull-back holding the high-impedance
  // gain node within the rails (VLIMP=V(Vcc+)-vSatPos, VLIMN=V(Vcc-)+vSatNeg).
  // Linear (conductance K) so it converges where a stiff diode clamp does not. BI
  // injects the expression current at out+, so out+ wires to npole1 and the
  // over-rail term is negative (pulls the node back down).
  const K = 10000;
  const vLimExpr =
    `gt0(V(np)-V(vp)+${vSatPos})?(0-${K}*(V(np)-V(vp)+${vSatPos}))` +
    `:(lt0(V(np)-V(vn)-${vSatNeg})?(0-${K}*(V(np)-V(vn)-${vSatNeg})):0)`;

  // Current limiter (Verilog-A reference Fig 28): output current is
  // (V(npole1)-V(out)).gOut through the buffer+rOut; when |Iout|>iMax pull npole1
  // back so the drive - hence Iout - is clamped. Inert at no load (Iout~0). Same
  // BI pull-back at out+=npole1.
  const gOut = 1 / Math.max(rOut, 1e-9);
  const KI = 20;
  const iLimExpr =
    `gt0((V(np)-V(o))*${gOut}-${iMax})?(0-${KI}*((V(np)-V(o))*${gOut}-${iMax}))` +
    `:(lt0((V(np)-V(o))*${gOut}+${iMax})?(0-${KI}*((V(np)-V(o))*${gOut}+${iMax})):0)`;

  return {
    ports: ["in+", "in-", "out", "Vcc+", "Vcc-", "gnd"],
    elements: [
      // Input stage (Qucs Fig 8): differential input R + C, input bias current.
      { typeId: "Resistor",        modelRef: "behavioral", subElementName: "rD",  params: { resistance: rIn } },
      { typeId: "Capacitor",       modelRef: "behavioral", subElementName: "cD",  params: { capacitance: cIn } },
      { typeId: "DcCurrentSource", modelRef: "behavioral", subElementName: "ibP", params: { current: iBias } },
      { typeId: "DcCurrentSource", modelRef: "behavioral", subElementName: "ibN", params: { current: iBias } },
      // Gain stage with slew: srp*tanh((vd+vos)/srp) injected straight into npole1.
      { typeId: "BehavioralLogic", modelRef: "default",    subElementName: "gmSlew", params: { expression: { kind: "literal", value: gmSlewExpr } } },
      // Dominant pole: RADO=Aol(DC), CP1 sets gbw (Qucs eq 1-3).
      { typeId: "Resistor",        modelRef: "behavioral", subElementName: "rAdo", params: { resistance: aol } },
      { typeId: "Capacitor",       modelRef: "behavioral", subElementName: "cP1",  params: { capacitance: cP1 } },
      // Rail clamp + output current limit (both pull npole1 back at out+).
      { typeId: "BehavioralLogic", modelRef: "default",    subElementName: "vLim", params: { expression: { kind: "literal", value: vLimExpr } } },
      { typeId: "BehavioralLogic", modelRef: "default",    subElementName: "iLim", params: { expression: { kind: "literal", value: iLimExpr } } },
      // Output stage (Qucs Fig 11): unity VCVS buffer + Thevenin output R.
      { typeId: "VCVS",            modelRef: "behavioral", subElementName: "eBuf", params: { gain: 1 } },
      { typeId: "Resistor",        modelRef: "behavioral", subElementName: "rOut", params: { resistance: rOut } },
    ],
    internalNetCount: 2,
    internalNetLabels: ["npole1", "nbuf"],
    netlist: [
      [0, 1],          // rD:  in+, in-
      [0, 1],          // cD:  in+, in-
      [0, 5],          // ibP: neg=in+, pos=gnd
      [1, 5],          // ibN: neg=in-, pos=gnd
      [0, 1, 6, 5],    // gmSlew: p=in+, n=in-, out+=npole1, out-=gnd
      [6, 5],          // rAdo: npole1, gnd
      [6, 5],          // cP1:  npole1, gnd
      [6, 3, 4, 6, 5], // vLim: np=npole1, vp=Vcc+, vn=Vcc-, out+=npole1, out-=gnd
      [6, 2, 6, 5],    // iLim: np=npole1, o=out, out+=npole1, out-=gnd
      [6, 5, 7, 5],    // eBuf: ctrl+=npole1, ctrl-=gnd, out+=nbuf, out-=gnd
      [7, 2],          // rOut: nbuf, out
    ],
  };
};

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildRealOpAmpPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in-",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "in+",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "Vcc+",
      defaultBitWidth: 1,
      position: { x: 2, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "Vcc-",
      defaultBitWidth: 1,
      position: { x: 2, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// RealOpAmpElement  CircuitElement
// ---------------------------------------------------------------------------

export class RealOpAmpElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RealOpAmp", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildRealOpAmpPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vVccP = signals?.getPinVoltage("Vcc+");
    const vVccN = signals?.getPinVoltage("Vcc-");

    ctx.save();
    ctx.setLineWidth(1);

    const triLeft = 0;
    const triRight = 4;

    // Triangle body  stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [{ x: triLeft, y: -2 }, { x: triRight, y: 0 }, { x: triLeft, y: 2 }],
      false,
    );

    // Supply rail stubs: Vcc+ stub
    drawColoredLead(ctx, signals, vVccP, 2, -2, 2, -1);

    // Supply rail stubs: Vcc- stub
    drawColoredLead(ctx, signals, vVccN, 2, 2, 2, 1);

    // +/- signs  body decoration, stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText('-', 13 / 16, -18 / 16, { horizontal: "center", vertical: "middle" });
    ctx.drawText('+', 13 / 16, 16 / 16, { horizontal: "center", vertical: "middle" });

    // Supply pin labels
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("V+", 2.4, -1.0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("V−", 2.4, 1.0, { horizontal: "left", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const REAL_OPAMP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const REAL_OPAMP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model",    propertyKey: "model",    convert: (v) => v },
  { xmlName: "aol",      propertyKey: "aol",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "gbw",      propertyKey: "gbw",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "slewRate", propertyKey: "slewRate", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vos",      propertyKey: "vos",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "iBias",    propertyKey: "iBias",    convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rIn",      propertyKey: "rIn",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rOut",     propertyKey: "rOut",     convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "iMax",     propertyKey: "iMax",     convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vSatPos",  propertyKey: "vSatPos",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vSatNeg",  propertyKey: "vSatNeg",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",    propertyKey: "label",    convert: (v) => v },
];

// ---------------------------------------------------------------------------
// RealOpAmpDefinition
// ---------------------------------------------------------------------------

export const RealOpAmpDefinition: StandaloneComponentDefinition = {
  name: "RealOpAmp",
  typeId: -1,
  pairedSpiceEquivalent: true,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildRealOpAmpPinDeclarations(),
  voltageProbes: [
    { name: "Vid", pos: "in+", neg: "in-" },
    { name: "Vsup", pos: "Vcc+", neg: "Vcc-" },
  ],
  propertyDefs: REAL_OPAMP_PROPERTY_DEFS,
  attributeMap: REAL_OPAMP_ATTRIBUTE_MAPPINGS,

  helpText:
    "Real Op-Amp  composite model with finite gain, GBW, slew rate, " +
    "input offset/bias, output resistance, current limiting, and rail saturation. " +
    "Pins: in+, in-, out, Vcc+, Vcc-.",

  factory(props: PropertyBag): RealOpAmpElement {
    return new RealOpAmpElement(
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      props,
    );
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: buildRealOpAmpNetlist,
      paramDefs: REAL_OPAMP_PARAM_DEFS,
      params: REAL_OPAMP_DEFAULTS,
    },
    ...Object.fromEntries(
      Object.entries(REAL_OPAMP_MODELS).map(([name, params]) => [
        name,
        {
          kind: "netlist" as const,
          netlist: buildRealOpAmpNetlist,
          paramDefs: REAL_OPAMP_PARAM_DEFS,
          params,
        },
      ]),
    ),
  },
  defaultModel: "behavioral",
};
