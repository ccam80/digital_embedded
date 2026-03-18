/**
 * Triode vacuum tube analog component — Koren model.
 *
 * The Koren model is the standard for audio amplifier simulation. The plate
 * current depends on both plate voltage and grid voltage via:
 *
 *   E₁ = V_PK / K_P · ln(1 + exp(K_P · (1/µ + V_GK / sqrt(K_VB + V_PK²))))
 *   I_P = (E₁ / K_G1)^EX   when E₁ > 0, else 0
 *
 * Grid current when V_GK > 0:
 *   I_G = (V_GK / R_GI)   (resistive grid current for positive grid drive)
 *
 * The triode is a three-terminal device:
 *   nodeIndices[0] = node_P  (plate / anode)
 *   nodeIndices[1] = node_G  (grid)
 *   nodeIndices[2] = node_K  (cathode)
 *
 * The linearised Koren model stamps:
 *   - Plate transconductance: gm = dI_P/dV_GK
 *   - Plate conductance: gp = dI_P/dV_PK
 *   - Grid conductance: ggi = 1/R_GI (when V_GK > 0)
 *   - Norton current sources at P, G, K nodes
 *
 * Voltage limiting: V_GK steps are clamped to prevent exponential overflow
 * in the Koren E₁ formula.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability. */
const GMIN = 1e-12;

/** Maximum V_GK step per NR iteration (prevents exponential overflow). */
const VGK_MAX_STEP = 1.0;

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------

function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

function stampRHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
}

// ---------------------------------------------------------------------------
// Koren model operating-point computation
// ---------------------------------------------------------------------------

interface TriodeOperatingPoint {
  vgk: number;
  vpk: number;
  ip: number;
  ig: number;
  /** dI_P/dV_GK — transconductance */
  gm: number;
  /** dI_P/dV_PK — plate conductance */
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

  // Koren E₁ inner argument
  const innerArg = kp * (1 / mu + vgk / Math.sqrt(kvb + vpkSafe * vpkSafe));

  // E₁ = V_PK/K_P · ln(1 + exp(innerArg)), clamped to prevent overflow
  const clampedArg = Math.min(innerArg, 500);
  const logTerm = Math.log1p(Math.exp(clampedArg));
  const e1 = (vpkSafe / kp) * logTerm;

  // I_P = (E₁/K_G1)^EX when E₁ > 0
  const ip = e1 > 0 ? Math.pow(e1 / kg1, ex) : 0;

  // Grid current: resistive when V_GK > 0
  const ig = vgk > 0 ? vgk / rGI : 0;
  const ggi = vgk > 0 ? 1 / rGI : GMIN;

  // --- Analytical Jacobian for NR linearisation ---
  //
  // dE₁/dV_GK = (vpkSafe/kp) · exp(innerArg)/(1+exp(innerArg)) · kp/sqrt(kvb+vpk²)
  //           = vpkSafe · exp(innerArg)/(1+exp(innerArg)) / sqrt(kvb+vpk²)
  //
  // dE₁/dV_PK:
  //   Term 1: (1/kp) · ln(1+exp(innerArg))   [from ∂(vpkSafe/kp)/∂V_PK]
  //   Term 2: (vpkSafe/kp) · exp(innerArg)/(1+exp(innerArg)) · kp·(-vpkSafe/(kvb+vpkSafe²)^(3/2))·vpkSafe
  //         = -vpkSafe² · exp(innerArg)/(1+exp(innerArg)) / (kvb+vpkSafe²)^(3/2) · (vpkSafe/kp)... wait
  //
  // Let sq = sqrt(kvb + vpkSafe²), so dSq/dVpk = vpkSafe/sq.
  // innerArg = kp*(1/mu + vgk/sq)
  // d(innerArg)/dVpk = kp * vgk * (-1/sq²) * (vpkSafe/sq) = -kp*vgk*vpkSafe/sq³
  //
  // dE₁/dVpk = logTerm/kp + (vpkSafe/kp)*sigmoid*(-kp*vgk*vpkSafe/sq³)
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

  // dI_P/dE₁ = EX * (E₁/K_G1)^(EX-1) / K_G1  when E₁ > 0
  const dIpdE1 = e1 > 0 ? ex * Math.pow(e1 / kg1, ex - 1) / kg1 : 0;

  const gm = dIpdE1 * dE1dVgk + GMIN;
  const gp = dIpdE1 * dE1dVpk + GMIN;

  return { vgk, vpk, ip, ig, gm, gp, ggi };
}

// ---------------------------------------------------------------------------
// createTriodeElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createTriodeElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeP = nodeIds[0]; // plate
  const nodeG = nodeIds[1]; // grid
  const nodeK = nodeIds[2]; // cathode

  const mu = props.getOrDefault<number>("mu", 100);
  const kp = props.getOrDefault<number>("kp", 600);
  const kvb = props.getOrDefault<number>("kvb", 300);
  const kg1 = props.getOrDefault<number>("kg1", 1060);
  const ex = props.getOrDefault<number>("ex", 1.4);
  const rGI = props.getOrDefault<number>("rGI", 2000);

  // Initial operating point at V_GK=0, V_PK=0
  let vgk = 0;
  let vpk = 0;
  let op = computeTriodeOp(vgk, vpk, mu, kp, kvb, kg1, ex, rGI);

  return {
    nodeIndices: [nodeP, nodeG, nodeK],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No topology-constant linear contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      const { ip, ig, gm, gp, ggi } = op;
      const vgkOp = op.vgk;
      const vpkOp = op.vpk;

      // Norton equivalents:
      //   I_P = ip + gm*(V_GK - vgkOp) + gp*(V_PK - vpkOp)
      //       = ip - gm*vgkOp - gp*vpkOp + gm*V_GK + gp*V_PK
      //
      //   Norton current (independent term):
      //     ipNorton = ip - gm*vgkOp - gp*vpkOp
      //
      //   At node P: +I_P flows in (conventional: I_P from K to P through tube)
      //   At node K: -I_P flows out
      //
      //   Grid current I_G: ggi*(V_GK) = ggi*(V_G - V_K)
      //   ipNorton includes contribution at P from grid (through gm).

      const ipNorton = ip - gm * vgkOp - gp * vpkOp;
      const igNorton = ig - ggi * vgkOp;

      // Plate conductance gp between P and K
      stampG(solver, nodeP, nodeP, gp);
      stampG(solver, nodeP, nodeK, -gp);
      stampG(solver, nodeK, nodeP, -gp);
      stampG(solver, nodeK, nodeK, gp);

      // Transconductance gm: VCCS gm*(V_G - V_K) from K to P
      // Adds gm to [P,G], -gm to [P,K], -gm to [K,G], +gm to [K,K]
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
      // Plate: current flows from K to P (positive ip into plate node)
      stampRHS(solver, nodeP, -ipNorton);
      stampRHS(solver, nodeK, ipNorton);

      // Grid: current flows from K to G (positive ig into grid node)
      stampRHS(solver, nodeG, -igNorton);
      stampRHS(solver, nodeK, igNorton);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vP = nodeP > 0 ? voltages[nodeP - 1] : 0;
      const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
      const vK = nodeK > 0 ? voltages[nodeK - 1] : 0;

      const vgkNew = vG - vK;
      const vpkNew = vP - vK;

      // Voltage limiting: clamp V_GK step
      const dvgk = vgkNew - vgk;
      const limitedDvgk = Math.max(-VGK_MAX_STEP, Math.min(VGK_MAX_STEP, dvgk));
      vgk = vgk + limitedDvgk;
      vpk = vpkNew;

      op = computeTriodeOp(vgk, vpk, mu, kp, kvb, kg1, ex, rGI);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const vPn = nodeP > 0 ? voltages[nodeP - 1] : 0;
      const vGn = nodeG > 0 ? voltages[nodeG - 1] : 0;
      const vKn = nodeK > 0 ? voltages[nodeK - 1] : 0;
      const vPp = nodeP > 0 ? prevVoltages[nodeP - 1] : 0;
      const vGp = nodeG > 0 ? prevVoltages[nodeG - 1] : 0;
      const vKp = nodeK > 0 ? prevVoltages[nodeK - 1] : 0;

      const dvgk = Math.abs((vGn - vKn) - (vGp - vKp));
      const dvpk = Math.abs((vPn - vKn) - (vPp - vKp));

      return dvgk <= 0.1 && dvpk <= 0.5;
    },
  };
}

// ---------------------------------------------------------------------------
// TriodeCircuitElement — AbstractCircuitElement (editor/visual layer)
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
      x: this.position.x - 0.5,
      y: this.position.y - 2,
      width: 3,
      height: 4,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Envelope circle
    ctx.drawCircle(1, 0, 1.8, false);

    // Cathode (bottom) — horizontal line with lead
    ctx.drawLine(0.4, 1.2, 1.6, 1.2);
    ctx.drawLine(1, 1.2, 1, 2);

    // Grid (middle) — dashed horizontal line with lead
    ctx.drawLine(0.3, 0.3, 0.9, 0.3);
    ctx.drawLine(1.1, 0.3, 1.7, 0.3);
    ctx.drawLine(0, 0.3, 0.3, 0.3);

    // Plate (top) — horizontal line with lead
    ctx.drawLine(0.4, -0.9, 1.6, -0.9);
    ctx.drawLine(1, -0.9, 1, -2);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1, -2.3, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Triode vacuum tube — Koren model.\n" +
      "Pins: P (plate), G (grid), K (cathode).\n" +
      "Standard 12AX7 defaults: µ=100, K_P=600, K_VB=300, K_G1=1060, EX=1.4."
    );
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
      position: { x: 1, y: -2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0.3 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 1, y: 2 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRIODE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "mu",
    type: PropertyType.FLOAT,
    label: "µ (amplification factor)",
    defaultValue: 100,
    min: 1,
    description: "Amplification factor µ",
  },
  {
    key: "kp",
    type: PropertyType.FLOAT,
    label: "K_P",
    defaultValue: 600,
    min: 1,
    description: "Koren K_P parameter controlling plate-voltage sensitivity",
  },
  {
    key: "kvb",
    type: PropertyType.FLOAT,
    label: "K_VB",
    defaultValue: 300,
    min: 0,
    description: "Koren K_VB parameter (V²) for grid-plate interaction",
  },
  {
    key: "kg1",
    type: PropertyType.FLOAT,
    label: "K_G1",
    defaultValue: 1060,
    min: 1,
    description: "Koren K_G1 transconductance scaling factor",
  },
  {
    key: "ex",
    type: PropertyType.FLOAT,
    label: "EX (exponent)",
    defaultValue: 1.4,
    min: 1,
    description: "Koren current exponent EX",
  },
  {
    key: "rGI",
    type: PropertyType.FLOAT,
    label: "R_GI (Ω)",
    defaultValue: 2000,
    min: 1,
    description: "Grid input resistance (limits grid current when V_GK > 0)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRIODE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "mu",    propertyKey: "mu",    convert: (v) => parseFloat(v) },
  { xmlName: "kp",    propertyKey: "kp",    convert: (v) => parseFloat(v) },
  { xmlName: "kvb",   propertyKey: "kvb",   convert: (v) => parseFloat(v) },
  { xmlName: "kg1",   propertyKey: "kg1",   convert: (v) => parseFloat(v) },
  { xmlName: "ex",    propertyKey: "ex",    convert: (v) => parseFloat(v) },
  { xmlName: "rGI",   propertyKey: "rGI",   convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
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
  engineType: "analog",
  factory: triodeCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildTriodePinDeclarations(),
  propertyDefs: TRIODE_PROPERTY_DEFS,
  attributeMap: TRIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Triode vacuum tube — Koren model.\n" +
    "Pins: P (plate), G (grid), K (cathode).\n" +
    "Standard 12AX7 defaults: µ=100, K_P=600, K_VB=300, K_G1=1060, EX=1.4.",
  analogFactory: (nodeIds, branchIdx, props) => createTriodeElement(nodeIds, branchIdx, props),
};
