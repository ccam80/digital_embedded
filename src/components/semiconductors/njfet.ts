/**
 * N-channel JFET analog component.
 *
 * Implements the Shichman-Hodges JFET model with:
 *   - Three operating regions: cutoff, linear, saturation
 *   - Gate-source pn junction (conducts when forward-biased)
 *   - Channel-length modulation via LAMBDA
 *   - Voltage limiting via pnjlim on V_GS gate junction
 *   - Junction capacitances CGS and CGD
 *
 * I-V equations (N-channel):
 *   V_P = VTO (pinch-off voltage, negative for N-channel)
 *   Cutoff  (V_GS <= V_P):                 I_DS = 0
 *   Linear  (0 < V_DS < V_GS - V_P):       I_DS = β·[(V_GS-V_P)·V_DS - V_DS²/2]·(1+λ·V_DS)
 *   Saturation (V_DS >= V_GS - V_P > 0):   I_DS = β/2·(V_GS-V_P)²·(1+λ·V_DS)
 *
 * Gate junction diode:
 *   I_G = IS·(exp(V_GS/(N·Vt)) - 1)    (normally reverse biased)
 *
 * MNA stamp convention (3-terminal: G, D, S):
 *   Norton equivalent from linearized I-V: gm + gds conductances
 *   Gate diode: additional Norton equivalent at G and S nodes
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
import { AbstractFetElement } from "../../solver/analog/fet-base.js";
import type { FetCapacitances } from "../../solver/analog/fet-base.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { JFET_N_DEFAULTS } from "../../solver/analog/model-defaults.js";

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
// JfetParams — resolved model parameters
// ---------------------------------------------------------------------------

interface JfetParams {
  VTO: number;
  BETA: number;
  LAMBDA: number;
  IS: number;
  CGS: number;
  CGD: number;
  PB: number;
  FC: number;
  RD: number;
  RS: number;
  KF: number;
  AF: number;
}

function resolveJfetParams(
  props: PropertyBag,
  defaults: Record<string, number>,
): JfetParams {
  const modelParams = props.has("_modelParams")
    ? props.get<Record<string, number>>("_modelParams")
    : undefined;
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

// ---------------------------------------------------------------------------
// NJfetAnalogElement — AbstractFetElement subclass
// ---------------------------------------------------------------------------

/**
 * N-channel JFET analog element.
 *
 * Uses the Shichman-Hodges model for I_DS and a Shockley diode equation
 * for the gate-source junction current. Extends AbstractFetElement for the
 * shared NR stamping skeleton.
 */
export class NJfetAnalogElement extends AbstractFetElement {
  readonly polaritySign: 1 | -1 = 1;

  protected readonly _p: JfetParams;

  // Gate junction diode NR state
  protected _vgs_junction: number = 0;
  protected _gd_junction: number = GMIN;
  protected _id_junction: number = 0;

  constructor(
    gateNode: number,
    drainNode: number,
    sourceNode: number,
    p: JfetParams,
  ) {
    super(gateNode, drainNode, sourceNode);
    this._p = p;
    const hasCaps = p.CGS > 0 || p.CGD > 0;
    this._initReactive(hasCaps);
  }

  limitVoltages(
    vgsOld: number,
    _vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped?: boolean } {
    const vcrit = VT * Math.log(VT / (Math.SQRT2 * this._p.IS));
    const vgsLimited = pnjlim(vgsNew, vgsOld, VT, vcrit);

    // Clamp Vds to prevent huge steps
    let vds = vdsNew;
    if (vds < -10) vds = -10;
    if (vds > 50) vds = 50;

    return { vgs: vgsLimited, vds, swapped: false };
  }

  computeIds(vgs: number, vds: number): number {
    const vp = this._p.VTO;
    const beta = this._p.BETA;
    const lambda = this._p.LAMBDA;

    const vgst = vgs - vp;

    if (vgst <= 0) {
      return 0;
    }

    if (vds < vgst) {
      // Linear region: 0 < Vds < Vgs - Vp
      return beta * (vgst * vds - vds * vds / 2) * (1 + lambda * vds);
    } else {
      // Saturation region: Vds >= Vgs - Vp
      return (beta / 2) * vgst * vgst * (1 + lambda * vds);
    }
  }

  computeGm(vgs: number, vds: number): number {
    const vp = this._p.VTO;
    const beta = this._p.BETA;
    const lambda = this._p.LAMBDA;

    const vgst = vgs - vp;

    if (vgst <= 0) {
      return GMIN;
    }

    if (vds < vgst) {
      // Linear: dIds/dVgs = beta * Vds * (1 + lambda*Vds)
      return beta * vds * (1 + lambda * vds) + GMIN;
    } else {
      // Saturation: dIds/dVgs = beta * (Vgs - Vp) * (1 + lambda*Vds)
      return beta * vgst * (1 + lambda * vds) + GMIN;
    }
  }

  computeGds(vgs: number, vds: number): number {
    const vp = this._p.VTO;
    const beta = this._p.BETA;
    const lambda = this._p.LAMBDA;

    const vgst = vgs - vp;

    if (vgst <= 0) {
      return GMIN;
    }

    if (vds < vgst) {
      // Linear: dIds/dVds = beta*(Vgst - Vds)*(1+lambda*Vds) + beta*(Vgst*Vds - Vds²/2)*lambda
      const term1 = beta * (vgst - vds) * (1 + lambda * vds);
      const term2 = beta * (vgst * vds - vds * vds / 2) * lambda;
      return term1 + term2 + GMIN;
    } else {
      // Saturation: dIds/dVds = beta/2 * Vgst² * lambda
      return (beta / 2) * vgst * vgst * lambda + GMIN;
    }
  }

  computeCapacitances(_vgs: number, _vds: number): FetCapacitances {
    return { cgs: this._p.CGS, cgd: this._p.CGD };
  }

  setParam(key: string, value: number): void {
    if (key in this._p) (this._p as unknown as Record<string, number>)[key] = value;
  }

  override updateOperatingPoint(voltages: Float64Array): void {
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;

    const vGraw = vG - vS;
    const vDraw = vD - vS;

    // Voltage limiting for channel
    const limited = this.limitVoltages(this._vgs, this._vds, vGraw, vDraw);
    this._vgs = limited.vgs;
    this._vds = limited.vds;
    this._swapped = false;

    // Recompute channel operating point
    this._ids = this.computeIds(this._vgs, this._vds);
    this._gm = this.computeGm(this._vgs, this._vds);
    this._gds = this.computeGds(this._vgs, this._vds);

    // Gate junction diode: limit V_GS for junction
    const vcrit = VT * Math.log(VT / (Math.SQRT2 * this._p.IS));
    this._vgs_junction = pnjlim(vGraw, this._vgs_junction, VT, vcrit);

    // Gate junction I-V (Shockley): Ig = IS*(exp(Vgs/(Vt)) - 1)
    const expArg = Math.min(this._vgs_junction / VT, 80);
    const igJunction = this._p.IS * (Math.exp(expArg) - 1);
    this._gd_junction = (this._p.IS / VT) * Math.exp(expArg) + GMIN;
    this._id_junction = igJunction;
  }

  override stampNonlinear(solver: SparseSolver): void {
    // Stamp channel current (from base class logic with polarity=1)
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    const gmS = this._gm * this._sourceScale;
    const gdsS = this._gds * this._sourceScale;

    // Transconductance gm
    stampG(solver, nodeD, nodeG, gmS);
    stampG(solver, nodeD, nodeS, -gmS);
    stampG(solver, nodeS, nodeG, -gmS);
    stampG(solver, nodeS, nodeS, gmS);

    // Output conductance gds
    stampG(solver, nodeD, nodeD, gdsS);
    stampG(solver, nodeD, nodeS, -gdsS);
    stampG(solver, nodeS, nodeD, -gdsS);
    stampG(solver, nodeS, nodeS, gdsS);

    // Norton current (channel)
    const nortonId = (this._ids - this._gm * this._vgs - this._gds * this._vds) * this._sourceScale;
    stampRHS(solver, nodeD, -nortonId);
    stampRHS(solver, nodeS, nortonId);

    // Gate junction diode Norton equivalent (between G and S)
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
// createNJfetElement — factory function
// ---------------------------------------------------------------------------

export function createNJfetElement(
  pinNodes: ReadonlyMap<string, number>,
  _branchIdx: number,
  props: PropertyBag,
): NJfetAnalogElement {
  const nodeG = pinNodes.get("G")!; // gate
  const nodeS = pinNodes.get("S")!; // source
  const nodeD = pinNodes.get("D")!; // drain

  const p = resolveJfetParams(props, JFET_N_DEFAULTS);
  return new NJfetAnalogElement(nodeG, nodeD, nodeS, p);
}

// ---------------------------------------------------------------------------
// NJfetElement — CircuitElement implementation (for rendering)
// ---------------------------------------------------------------------------

export class NJfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NJFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNJfetPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vG = signals?.getPinVoltage("G");
    const vD = signals?.getPinVoltage("D");
    const vS = signals?.getPinVoltage("S");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Channel bar: fillPolygon from Falstad pixels (51,-16),(51,16),(54,16),(54,-16) ÷ 16
    ctx.drawPolygon(
      [
        { x: 3.1875, y: -1 },
        { x: 3.1875, y: 1 },
        { x: 3.375, y: 1 },
        { x: 3.375, y: -1 },
      ],
      true,
    );

    // Gate arrow: fillPolygon from Falstad pixels (50,0),(42,-3),(42,3) ÷ 16
    ctx.drawPolygon(
      [
        { x: 3.125, y: 0 },
        { x: 2.625, y: -0.1875 },
        { x: 2.625, y: 0.1875 },
      ],
      true,
    );

    // Gate lead
    drawColoredLead(ctx, signals, vG, 0, 0, 3.125, 0);

    // Drain lead (top): Falstad (64,-16)→(64,-8)→(54,-8) ÷ 16
    drawColoredLead(ctx, signals, vD, 4, -1, 4, -0.5);
    ctx.drawLine(4, -0.5, 3.375, -0.5);

    // Source lead (bottom): Falstad (64,16)→(64,8)→(54,8) ÷ 16
    drawColoredLead(ctx, signals, vS, 4, 1, 4, 0.5);
    ctx.drawLine(4, 0.5, 3.375, 0.5);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildNJfetPinDeclarations(): PinDeclaration[] {
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
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
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
  {
    key: "model",
    type: PropertyType.STRING,
    label: "Model",
    defaultValue: "",
    description: "SPICE model name (blank = use built-in defaults)",
  },
  LABEL_PROPERTY_DEF,
  {
    key: "_spiceModelOverrides",
    type: PropertyType.STRING,
    label: "SPICE Model Overrides",
    defaultValue: {} as Record<string, number>,
    description: "User-supplied SPICE parameter overrides",
    hidden: true,
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const NJFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

function njfetCircuitFactory(props: PropertyBag): NJfetElement {
  return new NJfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NJfetDefinition: ComponentDefinition = {
  name: "NJFET",
  typeId: -1,
  factory: njfetCircuitFactory,
  pinLayout: buildNJfetPinDeclarations(),
  propertyDefs: JFET_PROPERTY_DEFS,
  attributeMap: NJFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel JFET — Shichman-Hodges model with gate junction.\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Model parameters: VTO, BETA, LAMBDA, IS, CGS, CGD.",
  models: {
    mnaModels: {
      behavioral: {
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createNJfetElement(pinNodes, branchIdx, props),
      deviceType: "NJFET",
    },
    },
  },
  defaultModel: "behavioral",
};
