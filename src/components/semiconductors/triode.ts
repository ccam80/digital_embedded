/**
 * Triode vacuum tube analog component â€” Koren model.
 *
 * The Koren model is the standard for audio amplifier simulation. The plate
 * current depends on both plate voltage and grid voltage via:
 *
 *   Eâ‚ = V_PK / K_P Â· ln(1 + exp(K_P Â· (1/Âµ + V_GK / sqrt(K_VB + V_PKÂ²))))
 *   I_P = (Eâ‚ / K_G1)^EX   when Eâ‚ > 0, else 0
 *
 * Grid current when V_GK > 0:
 *   I_G = (V_GK / R_GI)   (resistive grid current for positive grid drive)
 *
 * The triode is a three-terminal device:
 *   pinNodeIds[0] = node_P  (plate / anode)
 *   pinNodeIds[1] = node_G  (grid)
 *   pinNodeIds[2] = node_K  (cathode)
 *
 * The linearised Koren model stamps:
 *   - Plate transconductance: gm = dI_P/dV_GK
 *   - Plate conductance: gp = dI_P/dV_PK
 *   - Grid conductance: ggi = 1/R_GI (when V_GK > 0)
 *   - Norton current sources at P, G, K nodes
 *
 * Voltage limiting: V_GK steps are clamped to prevent exponential overflow
 * in the Koren Eâ‚ formula.
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
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams } from "../../core/model-params.js";

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
    mu:  { default: 100,  description: "Amplification factor Âµ" },
    kp:  { default: 600,  description: "Koren K_P parameter controlling plate-voltage sensitivity" },
    kg1: { default: 1060, description: "Koren K_G1 transconductance scaling factor" },
  },
  secondary: {
    kvb: { default: 300,  description: "Koren K_VB parameter (VÂ²) for grid-plate interaction" },
    ex:  { default: 1.4,  description: "Koren current exponent EX" },
    rGI: { default: 2000, unit: "Î©", description: "Grid input resistance (limits grid current when V_GK > 0)" },
  },
});

// ---------------------------------------------------------------------------
// Stamp helpers â€” node 0 is ground (skipped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Koren model operating-point computation
// ---------------------------------------------------------------------------

interface TriodeOperatingPoint {
  vgk: number;
  vpk: number;
  ip: number;
  ig: number;
  /** dI_P/dV_GK â€” transconductance */
  gm: number;
  /** dI_P/dV_PK â€” plate conductance */
  gp: number;
  /** Grid input conductance (1/R_GI when positive grid; GMIN otherwise) */
  ggi: number;
}

function computeTriodeOp(
  vgk: number,
  vpk: number,
  mu: number,
  kp: number,
  kvb: number,
  kg1: number,
  ex: number,
  rGI: number,
): TriodeOperatingPoint {
  // Clamp V_PK to avoid sqrt of negative
  const vpkSafe = Math.max(vpk, 0);

  // Koren Eâ‚ inner argument
  const innerArg = kp * (1 / mu + vgk / Math.sqrt(kvb + vpkSafe * vpkSafe));

  // Eâ‚ = V_PK/K_P Â· ln(1 + exp(innerArg)), clamped to prevent overflow
  const clampedArg = Math.min(innerArg, 500);
  const logTerm = Math.log1p(Math.exp(clampedArg));
  const e1 = (vpkSafe / kp) * logTerm;

  // I_P = (Eâ‚/K_G1)^EX when Eâ‚ > 0
  const ip = e1 > 0 ? Math.pow(e1 / kg1, ex) : 0;

  // Grid current: resistive when V_GK > 0
  const ig = vgk > 0 ? vgk / rGI : 0;
  const ggi = vgk > 0 ? 1 / rGI : GMIN;

  // --- Analytical Jacobian for NR linearisation ---
  //
  // dEâ‚/dV_GK = (vpkSafe/kp) Â· exp(innerArg)/(1+exp(innerArg)) Â· kp/sqrt(kvb+vpkÂ²)
  //           = vpkSafe Â· exp(innerArg)/(1+exp(innerArg)) / sqrt(kvb+vpkÂ²)
  //
  // dEâ‚/dV_PK:
  //   Term 1: (1/kp) Â· ln(1+exp(innerArg))   [from âˆ‚(vpkSafe/kp)/âˆ‚V_PK]
  //   Term 2: (vpkSafe/kp) Â· exp(innerArg)/(1+exp(innerArg)) Â· kpÂ·(-vpkSafe/(kvb+vpkSafeÂ²)^(3/2))Â·vpkSafe
  //         = -vpkSafeÂ² Â· exp(innerArg)/(1+exp(innerArg)) / (kvb+vpkSafeÂ²)^(3/2) Â· (vpkSafe/kp)... wait
  //
  // Let sq = sqrt(kvb + vpkSafeÂ²), so dSq/dVpk = vpkSafe/sq.
  // innerArg = kp*(1/mu + vgk/sq)
  // d(innerArg)/dVpk = kp * vgk * (-1/sqÂ²) * (vpkSafe/sq) = -kp*vgk*vpkSafe/sqÂ³
  //
  // dEâ‚/dVpk = logTerm/kp + (vpkSafe/kp)*sigmoid*(-kp*vgk*vpkSafe/sqÂ³)
  //          = logTerm/kp - vpkSafeÂ²*vgk*sigmoid/sqÂ³
  //   where sigmoid = exp(innerArg)/(1+exp(innerArg))

  const sq = Math.sqrt(kvb + vpkSafe * vpkSafe);
  const sigmoid = clampedArg > 499
    ? 1.0
    : Math.exp(clampedArg) / (1 + Math.exp(clampedArg));

  const dE1dVgk = e1 > 0 ? vpkSafe * sigmoid / sq : 0;
  const dE1dVpk = e1 > 0
    ? logTerm / kp - vpkSafe * vpkSafe * vgk * sigmoid / (sq * sq * sq)
    : 0;

  // dI_P/dEâ‚ = EX * (Eâ‚/K_G1)^(EX-1) / K_G1  when Eâ‚ > 0
  const dIpdE1 = e1 > 0 ? ex * Math.pow(e1 / kg1, ex - 1) / kg1 : 0;

  const gm = dIpdE1 * dE1dVgk + GMIN;
  const gp = dIpdE1 * dE1dVpk + GMIN;

  return { vgk, vpk, ip, ig, gm, gp, ggi };
}

// ---------------------------------------------------------------------------
// createTriodeElement â€” AnalogElement factory
// ---------------------------------------------------------------------------

export function createTriodeElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeP = pinNodes.get("P")!; // plate
  const nodeG = pinNodes.get("G")!; // grid
  const nodeK = pinNodes.get("K")!; // cathode

  const p = {
    mu:  props.getModelParam<number>("mu"),
    kp:  props.getModelParam<number>("kp"),
    kvb: props.getModelParam<number>("kvb"),
    kg1: props.getModelParam<number>("kg1"),
    ex:  props.getModelParam<number>("ex"),
    rGI: props.getModelParam<number>("rGI"),
  };

  // Initial operating point at V_GK=0, V_PK=0
  let vgk = 0;
  let vpk = 0;
  let op = computeTriodeOp(vgk, vpk, p.mu, p.kp, p.kvb, p.kg1, p.ex, p.rGI);

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const voltages = ctx.rhsOld;
      const vP = voltages[nodeP];
      const vG = voltages[nodeG];
      const vK = voltages[nodeK];

      const vgkNew = vG - vK;
      const vpkNew = vP - vK;

      // Voltage limiting: clamp V_GK step (prevents exponential overflow in Koren formula)
      const dvgk = vgkNew - vgk;
      const limitedDvgk = Math.max(-VGK_MAX_STEP, Math.min(VGK_MAX_STEP, dvgk));
      const limited = limitedDvgk !== dvgk;
      vgk = vgk + limitedDvgk;
      vpk = vpkNew;
      if (limited) ctx.noncon.value++;

      op = computeTriodeOp(vgk, vpk, p.mu, p.kp, p.kvb, p.kg1, p.ex, p.rGI);

      const { ip, ig, gm, gp, ggi } = op;
      const vgkOp = op.vgk;
      const vpkOp = op.vpk;

      // Norton equivalents:
      //   I_P = ip + gm*(V_GK - vgkOp) + gp*(V_PK - vpkOp)
      //   Norton current (independent term): ipNorton = ip - gm*vgkOp - gp*vpkOp
      const ipNorton = ip - gm * vgkOp - gp * vpkOp;
      const igNorton = ig - ggi * vgkOp;

      const solver = ctx.solver;

      // Plate conductance gp between P and K
      stampG(solver, nodeP, nodeP, gp);
      stampG(solver, nodeP, nodeK, -gp);
      stampG(solver, nodeK, nodeP, -gp);
      stampG(solver, nodeK, nodeK, gp);

      // Transconductance gm: VCCS gm*(V_G - V_K) from K to P
      stampG(solver, nodeP, nodeG, gm);
      stampG(solver, nodeP, nodeK, -gm);
      stampG(solver, nodeK, nodeG, -gm);
      stampG(solver, nodeK, nodeK, gm);

      // Grid conductance ggi between G and K
      stampG(solver, nodeG, nodeG, ggi);
      stampG(solver, nodeG, nodeK, -ggi);
      stampG(solver, nodeK, nodeG, -ggi);
      stampG(solver, nodeK, nodeK, ggi);

      // Norton RHS: inject independent current terms
      stampRHS(ctx.rhs, nodeP, -ipNorton);
      stampRHS(ctx.rhs, nodeK, ipNorton);
      stampRHS(ctx.rhs, nodeG, -igNorton);
      stampRHS(ctx.rhs, nodeK, igNorton);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const vP = voltages[nodeP];
      const vG = voltages[nodeG];
      const vK = voltages[nodeK];

      const { ip, ig, gm, gp, ggi, vgk: vgkOp, vpk: vpkOp } = op;

      // Plate current: I_P = ip + gp*(V_PK - vpkOp) + gm*(V_GK - vgkOp)
      // Positive = flowing into the plate (from external circuit into element)
      const iPlate = ip + gp * ((vP - vK) - vpkOp) + gm * ((vG - vK) - vgkOp);

      // Grid current: I_G = ig + ggi*(V_GK - vgkOp)
      // Positive = flowing into the grid
      const iGrid = ig + ggi * ((vG - vK) - vgkOp);

      // Cathode current: KCL â€” all three must sum to zero
      const iCathode = -(iPlate + iGrid);

      // pinLayout order: P, G, K
      return [iPlate, iGrid, iCathode];
    },

    checkConvergence(ctx: LoadContext): boolean {
      const voltages = ctx.rhsOld;
      const vP = voltages[nodeP];
      const vG = voltages[nodeG];
      const vK = voltages[nodeK];

      const vgkRaw = vG - vK;
      const vpkRaw = vP - vK;

      // BJTconvTest-style current prediction for triode
      const delvgk = vgkRaw - vgk;
      const delvpk = vpkRaw - vpk;

      const { ip, ig, gm: gmOp, gp: gpOp, ggi: ggiOp } = op;

      const cphat = ip + gmOp * delvgk + gpOp * delvpk;
      const cghat = ig + ggiOp * delvgk;

      const tolP = ctx.reltol * Math.max(Math.abs(cphat), Math.abs(ip)) + ctx.iabstol;
      const tolG = ctx.reltol * Math.max(Math.abs(cghat), Math.abs(ig)) + ctx.iabstol;

      return Math.abs(cphat - ip) <= tolP && Math.abs(cghat - ig) <= tolG;
    },

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// TriodeCircuitElement â€” AbstractCircuitElement (editor/visual layer)
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

    // All coordinates in grid units (Falstad pixels Ã· 16)
    // Reference: TriodeElm in fixtures/falstad-shapes.json
    // Origin: G pin at (0, 0), point2 at (4, 0)

    // Envelope circle: center (4, 0), r = 23.52/16 â‰ˆ 1.47
    ctx.drawCircle(4.0, 0.0, 23.52 / 16, false);

    // Plate lead: (4, -2) â†’ (4, -0.5)
    ctx.drawLine(4.0, -2.0, 4.0, -0.5);

    // Plate bar: (2.875, -0.5) â†’ (5.125, -0.5)
    ctx.drawLine(2.875, -0.5, 5.125, -0.5);

    // Grid lead: (0, 0) â†’ (2.5, 0)
    ctx.drawLine(0.0, 0.0, 2.5, 0.0);

    // Grid dashes (3 segments)
    ctx.drawLine(2.8125, 0.0, 3.1875, 0.0);
    ctx.drawLine(3.8125, 0.0, 4.1875, 0.0);
    ctx.drawLine(4.8125, 0.0, 5.1875, 0.0);

    // Cathode vertical: (3, 2) â†’ (3, 0.5)
    ctx.drawLine(3.0, 2.0, 3.0, 0.5);

    // Cathode horizontal: (3, 0.5) â†’ (5, 0.5)
    ctx.drawLine(3.0, 0.5, 5.0, 0.5);

    // Cathode stub: (5, 0.5) â†’ (5, 0.625)
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
    "Triode vacuum tube â€” Koren model.\n" +
    "Pins: P (plate), G (grid), K (cathode).\n" +
    "Standard 12AX7 defaults: Âµ=100, K_P=600, K_VB=300, K_G1=1060, EX=1.4.",
  models: {},
  modelRegistry: {
    "koren": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createTriodeElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: TRIODE_PARAM_DEFS,
      params: TRIODE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "koren",
};
