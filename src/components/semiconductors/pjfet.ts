/**
 * P-channel JFET analog component.
 *
 * Implements the polarity-inverted dual of the N-channel JFET.
 * The P-JFET uses the same Shichman-Hodges model with polaritySign = -1,
 * inverting all junction voltage signs and current directions.
 *
 * I-V equations (P-channel, VTO > 0):
 *   V_P = VTO (pinch-off, positive for P-channel)
 *   Uses polarity = -1: Vsg = Vs - Vg, Vsd = Vs - Vd
 *   Cutoff  (V_SG <= V_P):                 I_SD = 0
 *   Linear  (0 < V_SD < V_SG - V_P):       I_SD = β·[(V_SG-V_P)·V_SD - V_SD²/2]·(1+λ·V_SD)
 *   Saturation (V_SD >= V_SG - V_P > 0):   I_SD = β/2·(V_SG-V_P)²·(1+λ·V_SD)
 *
 * Gate junction (now between G and S, forward-biased when Vgs > 0 for P-JFET,
 * i.e. when Vg > Vs, i.e. the gate is positive relative to source):
 *   I_G = IS·(exp(V_GS/(Vt)) - 1) with V_GS sign inverted by polarity
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { NJfetAnalogElement } from "./njfet.js";
import type { LoadContext } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";
import { VT } from "../../core/constants.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT (thermal voltage) imported from ../../core/constants.js

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: PJFET_PARAM_DEFS, defaults: PJFET_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    VTO:    { default: 2.0,   unit: "V",    description: "Pinch-off (threshold) voltage" },
    BETA:   { default: 1e-4,  unit: "A/V²", description: "Transconductance coefficient" },
    LAMBDA: { default: 0.0,   unit: "1/V",  description: "Channel-length modulation" },
  },
  secondary: {
    IS:   { default: 1e-14, unit: "A",  description: "Gate junction saturation current" },
    N:    { default: 1.0,               description: "Gate junction emission coefficient" },
    CGS:  { default: 0,     unit: "F",  description: "Gate-source zero-bias capacitance" },
    CGD:  { default: 0,     unit: "F",  description: "Gate-drain zero-bias capacitance" },
    PB:   { default: 1.0,   unit: "V",  description: "Gate junction built-in potential" },
    FC:   { default: 0.5,               description: "Forward-bias capacitance coefficient" },
    RD:   { default: 0,     unit: "Ω",  description: "Drain ohmic resistance" },
    RS:   { default: 0,     unit: "Ω",  description: "Source ohmic resistance" },
    KF:   { default: 0,                 description: "Flicker noise coefficient" },
    AF:   { default: 1,                 description: "Flicker noise exponent" },
    TNOM: { default: 27,    unit: "°C", description: "Nominal temperature for parameters" },
  },
});

// ---------------------------------------------------------------------------
// PJfetAnalogElement
// ---------------------------------------------------------------------------

/**
 * P-channel JFET analog element.
 *
 * Extends NJfetAnalogElement with polaritySign = -1. All junction voltages
 * and currents are sign-inverted: internal computations use Vsg and Vsd
 * (source-gate and source-drain) as positive quantities when the device is on.
 */
export class PJfetAnalogElement extends NJfetAnalogElement {
  override readonly polaritySign: 1 | -1 = -1;

  override limitVoltages(
    vgsOld: number,
    _vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped?: boolean } {
    // For P-JFET, apply pnjlim on the sign-inverted gate junction
    const vt_n = VT * this._p.N;
    const vcrit = vt_n * Math.log(vt_n / (Math.SQRT2 * this._p.IS));
    const vgsResult = pnjlim(vgsNew, vgsOld, vt_n, vcrit);
    this._pnjlimLimited = vgsResult.limited;

    let vds = vdsNew;
    if (vds < -50) vds = -50;
    if (vds > 10) vds = 10;

    return { vgs: vgsResult.value, vds, swapped: false };
  }

  override primeJunctions(): void {
    // jfetload.c:115-118: MODEINITJCT sets vgs=-1, vgd=-1 (polarity handled at voltage-read time)
    this._vgs = -1;
    this._vds = 0;  // vgs - vgd = -1 - (-1) = 0
    this._vgs_junction = -1;
  }

  protected override _updateOp(ctx: LoadContext): void {
    const voltages = ctx.voltages;
    const limitingCollector = ctx.limitingCollector;
    // jfetload.c: during MODEINITJCT, primeJunctions() has already set _vgs, _vds,
    // _vgs_junction directly. Skip MNA voltage reads and all voltage limiting.
    if (this._pool.initMode === "initJct") {
      this._pnjlimLimited = false;
      this._swapped = false;

      this._ids = this.computeIds(this._vgs, this._vds);
      this._gm = this.computeGm(this._vgs, this._vds);
      this._gds = this.computeGds(this._vgs, this._vds);

      // Gate junction I-V at primed vgs_junction
      const vt_n = VT * this._p.N;
      const expArg = Math.min(this._vgs_junction / vt_n, 80);
      const igJunction = this._p.IS * (Math.exp(expArg) - 1);
      this._gd_junction = (this._p.IS / vt_n) * Math.exp(expArg) + GMIN;
      this._id_junction = igJunction;
      return;
    }

    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;

    // P-channel: use polarity = -1 inversion (Vsg = -(Vg - Vs), Vsd = -(Vd - Vs))
    const vGraw = -1 * (vG - vS);  // Vsg
    const vDraw = -1 * (vD - vS);  // Vsd

    this._pnjlimLimited = false;
    const limited = this.limitVoltages(this._vgs, this._vds, vGraw, vDraw);
    if (limitingCollector) {
      limitingCollector.push({
        elementIndex: this.elementIndex ?? -1,
        label: this.label ?? "",
        junction: "GS",
        limitType: "pnjlim",
        vBefore: vGraw,
        vAfter: limited.vgs,
        wasLimited: limited.vgs !== vGraw,
      });
    }
    this._vgs = limited.vgs; // internal Vsg (positive when device on)
    this._vds = limited.vds; // internal Vsd (positive)
    this._swapped = false;

    this._ids = this.computeIds(this._vgs, this._vds);
    this._gm = this.computeGm(this._vgs, this._vds);
    this._gds = this.computeGds(this._vgs, this._vds);

    // Gate junction: for P-JFET, junction is between G and S
    // Forward biased when Vgs > 0 (in raw terms, i.e. Vg > Vs)
    // Use raw Vgs (not polarity-inverted) for junction
    const vGSraw = vG - vS;
    const vt_n = VT * this._p.N;
    const vcrit = vt_n * Math.log(vt_n / (Math.SQRT2 * this._p.IS));
    const vgsJunctionBefore = this._vgs_junction;
    const gateJunctionResult = pnjlim(vGSraw, this._vgs_junction, vt_n, vcrit);
    this._vgs_junction = gateJunctionResult.value;
    this._pnjlimLimited = this._pnjlimLimited || gateJunctionResult.limited;
    if (limitingCollector) {
      limitingCollector.push({
        elementIndex: this.elementIndex ?? -1,
        label: this.label ?? "",
        junction: "GS_junction",
        limitType: "pnjlim",
        vBefore: vgsJunctionBefore,
        vAfter: this._vgs_junction,
        wasLimited: gateJunctionResult.limited,
      });
    }

    const expArg = Math.min(this._vgs_junction / vt_n, 80);
    const igJunction = this._p.IS * (Math.exp(expArg) - 1);
    this._gd_junction = (this._p.IS / vt_n) * Math.exp(expArg) + GMIN;
    this._id_junction = igJunction;
    if (this._pnjlimLimited) ctx.noncon.value++;
  }

  protected override _stampNonlinear(solver: SparseSolver): void {
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    const gmS = this._gm * this._sourceScale;
    const gdsS = this._gds * this._sourceScale;

    // For P-JFET: current flows from S to D (opposite to N-JFET)
    // Norton: I_SD = ids, with polarity = -1 meaning current into S, out of D
    // gm: dI_SD/dV_SG — stamp as current from D to S controlled by V_SG=Vgs(internal)
    // In terms of MNA nodes with polarity -1:
    // The linearized stamp is: current into D node = -ids_polarity

    // Transconductance: current from S to D controlled by V_SG
    // Stamp same topology as N-JFET but sign of Norton current inverted
    stampG(solver, nodeD, nodeG, -gmS);
    stampG(solver, nodeD, nodeS, gmS);
    stampG(solver, nodeS, nodeG, gmS);
    stampG(solver, nodeS, nodeS, -gmS);

    // Output conductance gds (for Vsd)
    stampG(solver, nodeD, nodeD, gdsS);
    stampG(solver, nodeD, nodeS, -gdsS);
    stampG(solver, nodeS, nodeD, -gdsS);
    stampG(solver, nodeS, nodeS, gdsS);

    // Norton current: polarity -1 means positive ids flows from S to D
    // KCL at S: +norton, at D: -norton
    const nortonId = (this._ids - this._gm * this._vgs - this._gds * this._vds) * this._sourceScale;
    stampRHS(solver, nodeS, -nortonId);
    stampRHS(solver, nodeD, nortonId);

    // Gate junction diode (between G and S, raw Vgs orientation)
    const gd = this._gd_junction * this._sourceScale;
    const nortonIg = (this._id_junction - this._gd_junction * this._vgs_junction) * this._sourceScale;

    stampG(solver, nodeG, nodeG, gd);
    stampG(solver, nodeG, nodeS, -gd);
    stampG(solver, nodeS, nodeG, -gd);
    stampG(solver, nodeS, nodeS, gd);

    stampRHS(solver, nodeG, -nortonIg);
    stampRHS(solver, nodeS, nortonIg);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPJfetElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PJfetAnalogElement {
  const nodeG = pinNodes.get("G")!; // gate
  const nodeD = pinNodes.get("D")!; // drain
  const nodeS = pinNodes.get("S")!; // source

  const p = {
    VTO:    props.getModelParam<number>("VTO"),
    BETA:   props.getModelParam<number>("BETA"),
    LAMBDA: props.getModelParam<number>("LAMBDA"),
    IS:     props.getModelParam<number>("IS"),
    N:      props.getModelParam<number>("N"),
    CGS:    props.getModelParam<number>("CGS"),
    CGD:    props.getModelParam<number>("CGD"),
    PB:     props.getModelParam<number>("PB"),
    FC:     props.getModelParam<number>("FC"),
    RD:     props.getModelParam<number>("RD"),
    RS:     props.getModelParam<number>("RS"),
    KF:     props.getModelParam<number>("KF"),
    AF:     props.getModelParam<number>("AF"),
    TNOM:   props.getModelParam<number>("TNOM"),
  };
  return new PJfetAnalogElement(nodeG, nodeD, nodeS, p);
}

// ---------------------------------------------------------------------------
// PJfetElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PJfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PJFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPJfetPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1.5,
      width: 3,
      height: 3,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vG = signals?.getPinVoltage("G");
    const vD = signals?.getPinVoltage("D");
    const vS = signals?.getPinVoltage("S");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const PX = 1 / 16;

    const chanX = 1.8;
    const chanTop = -1.0;
    const chanBot = 1.0;

    // Body (channel line, gate bar rect, arrow) stays COMPONENT color
    ctx.drawLine(chanX, chanTop, chanX, chanBot);

    const barWidth = 3 * PX;
    ctx.drawRect(
      chanX - barWidth / 2,
      chanTop + 0.15,
      barWidth,
      chanBot - chanTop - 0.3,
      true,
    );

    const arrowLen = 8 * PX;
    const arrowWid = 3 * PX;
    const barbF = 1 - arrowLen / chanX;
    const barbX = chanX * (1 - barbF);
    ctx.drawPolygon([
      { x: 0, y: 0 },
      { x: barbX, y: arrowWid },
      { x: barbX, y: -arrowWid },
    ], true);

    // Gate lead
    drawColoredLead(ctx, signals, vG, 0, 0, chanX, 0);

    // Drain lead (top)
    drawColoredLead(ctx, signals, vD, chanX, chanTop, 3, chanTop);
    ctx.drawLine(3, chanTop, 3, -1.5);

    // Source lead (bottom)
    drawColoredLead(ctx, signals, vS, chanX, chanBot, 3, chanBot);
    ctx.drawLine(3, chanBot, 3, 1.5);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPJfetPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4, y: 1.0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4, y: -1.0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JFET_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

export const PJFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

function pjfetCircuitFactory(props: PropertyBag): PJfetElement {
  return new PJfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PJfetDefinition: ComponentDefinition = {
  name: "PJFET",
  typeId: -1,
  factory: pjfetCircuitFactory,
  pinLayout: buildPJfetPinDeclarations(),
  propertyDefs: JFET_PROPERTY_DEFS,
  attributeMap: PJFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel JFET — Shichman-Hodges model (polarity inverted).\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Model parameters: VTO, BETA, LAMBDA, IS, CGS, CGD.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createPJfetElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: PJFET_PARAM_DEFS,
      params: PJFET_PARAM_DEFAULTS,
    },
  },
  defaultModel: "spice",
};
