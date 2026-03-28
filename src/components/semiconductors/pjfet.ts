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
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { NJfetAnalogElement } from "./njfet.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { JFET_P_DEFAULTS } from "../../solver/analog/model-defaults.js";
import type { FetCapacitances } from "../../solver/analog/fet-base.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------


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
    const vcrit = VT * Math.log(VT / (Math.SQRT2 * this._p.IS));
    const vgsLimited = pnjlim(vgsNew, vgsOld, VT, vcrit);

    let vds = vdsNew;
    if (vds < -50) vds = -50;
    if (vds > 10) vds = 10;

    return { vgs: vgsLimited, vds, swapped: false };
  }

  override updateOperatingPoint(voltages: Float64Array): void {
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;

    // P-channel: use polarity = -1 inversion (Vsg = -(Vg - Vs), Vsd = -(Vd - Vs))
    const vGraw = -1 * (vG - vS);  // Vsg
    const vDraw = -1 * (vD - vS);  // Vsd

    const limited = this.limitVoltages(this._vgs, this._vds, vGraw, vDraw);
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
    const vcrit = VT * Math.log(VT / (Math.SQRT2 * this._p.IS));
    this._vgs_junction = pnjlim(vGSraw, this._vgs_junction, VT, vcrit);

    const expArg = Math.min(this._vgs_junction / VT, 80);
    const igJunction = this._p.IS * (Math.exp(expArg) - 1);
    this._gd_junction = (this._p.IS / VT) * Math.exp(expArg) + GMIN;
    this._id_junction = igJunction;
  }

  override stampNonlinear(solver: SparseSolver): void {
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

function resolveJfetParams(props: PropertyBag, defaults: Record<string, number>) {
  const hasFn = typeof props.has === "function";
  const modelParams = hasFn
    ? (props.has("_modelParams") ? props.get<Record<string, number>>("_modelParams") : undefined)
    : (props as unknown as Record<string, unknown>)["_modelParams"] as Record<string, number> | undefined;
  const mp = modelParams ?? defaults;

  return {
    VTO: mp["VTO"] ?? defaults["VTO"],
    BETA: mp["BETA"] ?? defaults["BETA"],
    LAMBDA: mp["LAMBDA"] ?? defaults["LAMBDA"],
    IS: mp["IS"] ?? defaults["IS"],
    CGS: mp["CGS"] ?? defaults["CGS"],
    CGD: mp["CGD"] ?? defaults["CGD"],
    PB: mp["PB"] ?? defaults["PB"],
    FC: mp["FC"] ?? defaults["FC"],
    RD: mp["RD"] ?? defaults["RD"],
    RS: mp["RS"] ?? defaults["RS"],
    KF: mp["KF"] ?? defaults["KF"],
    AF: mp["AF"] ?? defaults["AF"],
  };
}

export function createPJfetElement(
  pinNodes: ReadonlyMap<string, number>,
  _branchIdx: number,
  props: PropertyBag,
): PJfetAnalogElement {
  const nodeG = pinNodes.get("G")!; // gate
  const nodeD = pinNodes.get("D")!; // drain
  const nodeS = pinNodes.get("S")!; // source

  const p = resolveJfetParams(props, JFET_P_DEFAULTS);
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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4, y: 1.0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4, y: -1.0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JFET_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "model",
    type: PropertyType.STRING,
    label: "Model",
    defaultValue: "",
    description: "SPICE model name (blank = use built-in defaults)",
  },
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
  models: {
    analog: {
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createPJfetElement(pinNodes, branchIdx, props),
      deviceType: "PJFET",
    },
  },
};
