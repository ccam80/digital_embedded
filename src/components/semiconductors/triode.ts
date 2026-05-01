/**
 * Triode vacuum tube analog component- Koren model.
 *
 * The Koren model is the standard for audio amplifier simulation. The plate
 * current depends on both plate voltage and grid voltage via:
 *
 *   E1 = V_PK / K_P · ln(1 + exp(K_P · (1/µ + V_GK / sqrt(K_VB + V_PK²))))
 *   I_P = (E1 / K_G1)^EX   when E1 > 0, else 0
 *
 * The triode is a three-terminal device:
 *   pinNodes.get("P") = plate / anode
 *   pinNodes.get("G") = grid
 *   pinNodes.get("K") = cathode
 *
 * Topology (per PB-TRIODE.md and plan.md "Resolved decisions"):
 *   1× VCCS sub-element (transconductance gm: control = G–K, output = P–K)
 *   + 2 extra gds output-conductance handles on (P,P) and (K,P).
 *
 * Total matrix entries allocated in setup() = 4 (VCCS) + 2 (gds) = 6.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams } from "../../core/model-params.js";
import { VCCSAnalogElement } from "../active/vccs.js";
import { parseExpression } from "../../solver/analog/expression.js";
import { differentiate, simplify } from "../../solver/analog/expression-differentiate.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability. */
const GMIN = 1e-12;

/** Maximum V_GK step per NR iteration (prevents exponential overflow). */
const VGK_MAX_STEP = 1.0;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRIODE_PARAM_DEFS, defaults: TRIODE_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    mu:  { default: 100,  description: "Amplification factor µ" },
    kp:  { default: 600,  description: "Koren K_P parameter controlling plate-voltage sensitivity" },
    kg1: { default: 1060, description: "Koren K_G1 transconductance scaling factor" },
  },
  secondary: {
    kvb: { default: 300,  description: "Koren K_VB parameter (V²) for grid-plate interaction" },
    ex:  { default: 1.4,  description: "Koren current exponent EX" },
    rGI: { default: 2000, unit: "Ω", description: "Grid input resistance (limits grid current when V_GK > 0)" },
  },
});

// ---------------------------------------------------------------------------
// Koren model operating-point computation
// ---------------------------------------------------------------------------

interface TriodeOperatingPoint {
  vgk: number;
  vpk: number;
  ip: number;
  /** dI_P/dV_GK- transconductance */
  gm: number;
  /** dI_P/dV_PK- plate (output) conductance */
  gds: number;
}

function computeTriodeOp(
  vgk: number,
  vpk: number,
  mu: number,
  kp: number,
  kvb: number,
  kg1: number,
  ex: number,
): TriodeOperatingPoint {
  // Clamp V_PK to avoid sqrt of negative
  const vpkSafe = Math.max(vpk, 0);

  // Koren E1 inner argument
  const innerArg = kp * (1 / mu + vgk / Math.sqrt(kvb + vpkSafe * vpkSafe));

  // E1 = V_PK/K_P · ln(1 + exp(innerArg)), clamped to prevent overflow
  const clampedArg = Math.min(innerArg, 500);
  const logTerm = Math.log1p(Math.exp(clampedArg));
  const e1 = (vpkSafe / kp) * logTerm;

  // I_P = (E1/K_G1)^EX when E1 > 0
  const ip = e1 > 0 ? Math.pow(e1 / kg1, ex) : 0;

  // --- Analytical Jacobian for NR linearisation ---
  //
  // Let sq = sqrt(kvb + vpkSafe²), so dSq/dVpk = vpkSafe/sq.
  // innerArg = kp*(1/mu + vgk/sq)
  // d(innerArg)/dVpk = kp * vgk * (-1/sq²) * (vpkSafe/sq) = -kp*vgk*vpkSafe/sq³
  //
  // dE1/dVpk = logTerm/kp + (vpkSafe/kp)*sigmoid*(-kp*vgk*vpkSafe/sq³)
  //          = logTerm/kp - vpkSafe²*vgk*sigmoid/sq³
  //   where sigmoid = exp(innerArg)/(1+exp(innerArg))

  const sq = Math.sqrt(kvb + vpkSafe * vpkSafe);
  const sigmoid = clampedArg > 499
    ? 1.0
    : Math.exp(clampedArg) / (1 + Math.exp(clampedArg));

  const dE1dVgk = e1 > 0 ? vpkSafe * sigmoid / sq : 0;
  const dE1dVpk = e1 > 0
    ? logTerm / kp - vpkSafe * vpkSafe * vgk * sigmoid / (sq * sq * sq)
    : 0;

  // dI_P/dE1 = EX * (E1/K_G1)^(EX-1) / K_G1  when E1 > 0
  const dIpdE1 = e1 > 0 ? ex * Math.pow(e1 / kg1, ex - 1) / kg1 : 0;

  const gm = dIpdE1 * dE1dVgk + GMIN;
  const gds = dIpdE1 * dE1dVpk + GMIN;

  return { vgk, vpk, ip, gm, gds };
}

// ---------------------------------------------------------------------------
// TriodeElement- composite analog element
// ---------------------------------------------------------------------------

class TriodeElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;

  /** VCCS sub-element carrying the 4 transconductance handles. */
  private readonly _vccs: VCCSAnalogElement;

  /** Plate node (digiTS pin "P"). */
  private readonly _nodeP: number;
  /** Cathode node (digiTS pin "K"). */
  private readonly _nodeK: number;
  /** Grid node (digiTS pin "G"). */
  private readonly _nodeG: number;

  /** Composite-owned gds handle on (plate, plate). */
  private _hPP_gds: number = -1;
  /** Composite-owned gds handle on (cathode, plate). */
  private _hKP_gds: number = -1;

  /** Koren model parameters (stored on the composite; forwarded to VCCS for parity). */
  private _p: {
    mu: number;
    kp: number;
    kvb: number;
    kg1: number;
    ex: number;
    rGI: number;
  };

  /** Cached operating point from previous load() call. */
  private _vgk: number = 0;
  private _vpk: number = 0;
  private _op: TriodeOperatingPoint;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    this._pinNodes = new Map(pinNodes);
    this._nodeP = pinNodes.get("P")!; // plate
    this._nodeG = pinNodes.get("G")!; // grid
    this._nodeK = pinNodes.get("K")!; // cathode

    this._p = {
      mu:  props.getModelParam<number>("mu"),
      kp:  props.getModelParam<number>("kp"),
      kvb: props.getModelParam<number>("kvb"),
      kg1: props.getModelParam<number>("kg1"),
      ex:  props.getModelParam<number>("ex"),
      rGI: props.getModelParam<number>("rGI"),
    };

    // Build the VCCS sub-element. Per PB-TRIODE pin mapping:
    //   out+ = P  (plate, output+)
    //   out- = K  (cathode, output-)
    //   ctrl+ = G (grid, control+)
    //   ctrl- = K (cathode, control-)
    // Constructing with a unity expression; actual stamping is done in load()
    // using the sub-element's cached TSTALLOC handles via this._vccs.stamps.
    const vccsExpr = parseExpression("V(ctrl)");
    const vccsDeriv = simplify(differentiate(vccsExpr, "V(ctrl)"));
    this._vccs = new VCCSAnalogElement(vccsExpr, vccsDeriv, "V(ctrl)", "voltage");
    this._vccs._pinNodes = new Map([
      ["ctrl+", this._nodeG],
      ["ctrl-", this._nodeK],
      ["out+",  this._nodeP],
      ["out-",  this._nodeK],
    ]);

    // Forward Koren params to the VCCS sub-element parameter store (per
    // PB-TRIODE setParam routing rule).
    for (const key of ["mu", "kp", "kvb", "kg1", "ex", "rGI"] as const) {
      this._vccs.setParam(key, this._p[key]);
    }

    // Initial operating point at V_GK=0, V_PK=0
    this._op = computeTriodeOp(0, 0, this._p.mu, this._p.kp, this._p.kvb, this._p.kg1, this._p.ex);
  }

  setup(ctx: SetupContext): void {
    this._vccs.setup(ctx);   // forwards to VccsAnalogElement.setup()- 4 entries
    const solver = ctx.solver;
    const nP = this._nodeP;  // plate node
    const nK = this._nodeK;  // cathode node

    // gds stamps- 2 additional entries (6 total for Triode).
    // Triode setup() unconditionally allocates 6 entries (4 VCCS + 2 gds,
    // gds always nonzero per Koren formula).
    this._hPP_gds = solver.allocElement(nP, nP);  // (plate, plate)
    this._hKP_gds = solver.allocElement(nK, nP);  // (cathode, plate)
  }

  load(ctx: LoadContext): void {
    const voltages = ctx.rhsOld;
    const vP = voltages[this._nodeP];
    const vG = voltages[this._nodeG];
    const vK = voltages[this._nodeK];

    const vgkNew = vG - vK;
    const vpkNew = vP - vK;

    // Voltage limiting: clamp V_GK step (prevents exponential overflow in Koren formula)
    const dvgk = vgkNew - this._vgk;
    const limitedDvgk = Math.max(-VGK_MAX_STEP, Math.min(VGK_MAX_STEP, dvgk));
    const limited = limitedDvgk !== dvgk;
    this._vgk = this._vgk + limitedDvgk;
    this._vpk = vpkNew;
    if (limited) ctx.noncon.value++;

    this._op = computeTriodeOp(
      this._vgk, this._vpk,
      this._p.mu, this._p.kp, this._p.kvb, this._p.kg1, this._p.ex,
    );

    const { ip, gm, gds } = this._op;
    const vgkOp = this._op.vgk;
    const vpkOp = this._op.vpk;

    const solver = ctx.solver;

    // Transconductance gm stamps via VCCS sub-element handles
    //   (ctrl+ = G, ctrl- = K, out+ = P, out- = K):
    //   (P,G) +gm   (P,K) -gm   (K,G) -gm   (K,K) +gm
    const { pCtP, pCtN, nCtP, nCtN } = this._vccs.stamps;
    solver.stampElement(pCtP, +gm);  // (P,G)
    solver.stampElement(pCtN, -gm);  // (P,K)
    solver.stampElement(nCtP, -gm);  // (K,G)
    solver.stampElement(nCtN, +gm);  // (K,K)

    // Output conductance gds stamps via composite-owned handles:
    //   (P,P) +gds   (K,P) -gds
    solver.stampElement(this._hPP_gds, +gds);
    solver.stampElement(this._hKP_gds, -gds);

    // Norton equivalent RHS:
    //   ieq = Ip - gm*Vgk - gds*Vpk
    //   stampRHS(P, -ieq); stampRHS(K, +ieq)
    const ieq = ip - gm * vgkOp - gds * vpkOp;
    stampRHS(ctx.rhs, this._nodeP, -ieq);
    stampRHS(ctx.rhs, this._nodeK, +ieq);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const vP = rhs[this._nodeP];
    const vG = rhs[this._nodeG];
    const vK = rhs[this._nodeK];

    const { ip, gm, gds } = this._op;
    const vgkOp = this._op.vgk;
    const vpkOp = this._op.vpk;

    // Plate current: I_P = ip + gm*(V_GK - vgkOp) + gds*(V_PK - vpkOp)
    // Positive = flowing into the plate (from external circuit into element)
    const iPlate = ip + gm * ((vG - vK) - vgkOp) + gds * ((vP - vK) - vpkOp);

    // Grid current: zero (no grid-current model in spec body).
    const iGrid = 0;

    // Cathode current: KCL- all three must sum to zero
    const iCathode = -(iPlate + iGrid);

    // pinLayout order: P, G, K
    return [iPlate, iGrid, iCathode];
  }

  checkConvergence(ctx: LoadContext): boolean {
    const voltages = ctx.rhsOld;
    const vP = voltages[this._nodeP];
    const vG = voltages[this._nodeG];
    const vK = voltages[this._nodeK];

    const vgkRaw = vG - vK;
    const vpkRaw = vP - vK;

    // BJTconvTest-style current prediction for triode
    const delvgk = vgkRaw - this._vgk;
    const delvpk = vpkRaw - this._vpk;

    const { ip, gm: gmOp, gds: gdsOp } = this._op;

    const cphat = ip + gmOp * delvgk + gdsOp * delvpk;

    const tolP = ctx.reltol * Math.max(Math.abs(cphat), Math.abs(ip)) + ctx.iabstol;

    return Math.abs(cphat - ip) <= tolP;
  }

  setParam(key: string, value: number): void {
    if (key in this._p) {
      (this._p as Record<string, number>)[key] = value;
      // Forward to VCCS sub-element parameter store (per PB-TRIODE setParam
      // routing rule).
      this._vccs.setParam(key, value);
    }
  }
}

// ---------------------------------------------------------------------------
// createTriodeElement- AnalogElement factory (3-arg signature per A.3)
// ---------------------------------------------------------------------------

export function createTriodeElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  return new TriodeElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// TriodeCircuitElement- AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class TriodeCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Triode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTriodePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 5.5,
      height: 4.0,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // All coordinates in grid units (Falstad pixels ÷ 16)
    // Reference: TriodeElm in fixtures/falstad-shapes.json
    // Origin: G pin at (0, 0), point2 at (4, 0)

    // Envelope circle: center (4, 0), r = 23.52/16 ≈ 1.47
    ctx.drawCircle(4.0, 0.0, 23.52 / 16, false);

    // Plate lead: (4, -2) → (4, -0.5)
    ctx.drawLine(4.0, -2.0, 4.0, -0.5);

    // Plate bar: (2.875, -0.5) → (5.125, -0.5)
    ctx.drawLine(2.875, -0.5, 5.125, -0.5);

    // Grid lead: (0, 0) → (2.5, 0)
    ctx.drawLine(0.0, 0.0, 2.5, 0.0);

    // Grid dashes (3 segments)
    ctx.drawLine(2.8125, 0.0, 3.1875, 0.0);
    ctx.drawLine(3.8125, 0.0, 4.1875, 0.0);
    ctx.drawLine(4.8125, 0.0, 5.1875, 0.0);

    // Cathode vertical: (3, 2) → (3, 0.5)
    ctx.drawLine(3.0, 2.0, 3.0, 0.5);

    // Cathode horizontal: (3, 0.5) → (5, 0.5)
    ctx.drawLine(3.0, 0.5, 5.0, 0.5);

    // Cathode stub: (5, 0.5) → (5, 0.625)
    ctx.drawLine(5.0, 0.5, 5.0, 0.625);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTriodePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "P",
      defaultBitWidth: 1,
      position: { x: 4, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
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
      direction: PinDirection.INPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 3, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRIODE_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRIODE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

function triodeCircuitFactory(props: PropertyBag): TriodeCircuitElement {
  return new TriodeCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TriodeDefinition: ComponentDefinition = {
  name: "Triode",
  typeId: -1,
  factory: triodeCircuitFactory,
  pinLayout: buildTriodePinDeclarations(),
  propertyDefs: TRIODE_PROPERTY_DEFS,
  attributeMap: TRIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Triode vacuum tube- Koren model.\n" +
    "Pins: P (plate), G (grid), K (cathode).\n" +
    "Standard 12AX7 defaults: µ=100, K_P=600, K_VB=300, K_G1=1060, EX=1.4.",
  models: {},
  modelRegistry: {
    "koren": {
      kind: "inline",
      factory: createTriodeElement,
      paramDefs: TRIODE_PARAM_DEFS,
      params: TRIODE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "koren",
};
