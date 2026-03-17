/**
 * BJT analog components — NPN and PNP bipolar junction transistors.
 *
 * Implements the Gummel-Poon Level 2 model with:
 *   - Forward and reverse Ebers-Moll currents
 *   - Early effect via VAF/VAR
 *   - High-injection limiting via IKF/IKR
 *   - Non-ideal base current via ISE/ISC
 *   - Voltage limiting via pnjlim() on both B-E and B-C junctions
 *
 * PNP is implemented as the NPN model with polarity = -1, which inverts all
 * junction voltage signs and current directions.
 *
 * MNA stamp convention for a 3-terminal device (C, B, E):
 *   The linearized Gummel-Poon model produces conductances between the
 *   three terminals plus Norton current sources.
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
import { pnjlim } from "../../analog/newton-raphson.js";
import { BJT_NPN_DEFAULTS, BJT_PNP_DEFAULTS } from "../../analog/model-defaults.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q). */
const VT = 0.02585;

/** Minimum conductance for numerical stability. */
const GMIN = 1e-12;

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
// Gummel-Poon model helper types
// ---------------------------------------------------------------------------

interface BjtOperatingPoint {
  /** Base-emitter junction voltage (signed, polarity-applied). */
  vbe: number;
  /** Base-collector junction voltage (signed, polarity-applied). */
  vbc: number;
  /** Collector current. */
  ic: number;
  /** Base current. */
  ib: number;
  /** Transconductance dIc/dVbe. */
  gm: number;
  /** Output conductance dIc/dVce = dIc/dVbc. */
  go: number;
  /** Input conductance dIb/dVbe. */
  gpi: number;
  /** Feedback conductance dIb/dVbc. */
  gmu: number;
}

// ---------------------------------------------------------------------------
// computeBjtOp — Gummel-Poon operating point
// ---------------------------------------------------------------------------

function computeBjtOp(
  vbe: number,
  vbc: number,
  IS: number,
  BF: number,
  NF: number,
  BR: number,
  NR: number,
  ISE: number,
  ISC: number,
  VAF: number,
  VAR: number,
  IKF: number,
  IKR: number,
): BjtOperatingPoint {
  const nfVt = NF * VT;
  const nrVt = NR * VT;

  // Forward and reverse junction exponentials
  const expVbe = Math.exp(Math.min(vbe / nfVt, 700));
  const expVbc = Math.exp(Math.min(vbc / nrVt, 700));

  // Forward and reverse transport currents
  const If = IS * (expVbe - 1);
  const Ir = IS * (expVbc - 1);

  // Base charge factor qb (Early effect + high injection)
  // qb = (1 + Vbc/VAR + Vbe/VAF) * (1 + sqrt(1 + If/IKF + Ir/IKR)) / 2
  // Simplified as per SPICE Level 1 Gummel-Poon: base charge factor handles
  // Early effect and high injection via two terms.

  const q1 = 1 / (1 - vbc / (VAR === Infinity ? 1e30 : VAR) - vbe / (VAF === Infinity ? 1e30 : VAF));
  const q2 = If / (IKF === Infinity ? 1e30 : IKF) + Ir / (IKR === Infinity ? 1e30 : IKR);
  const qb = q1 * (1 + Math.sqrt(1 + 4 * q2)) / 2;

  // Collector and base currents
  const ic = (If - Ir) / qb;

  // Non-ideal base current contributions (ISE, ISC with emission coefficients)
  // For simplicity we use NF and NR for ISE/ISC emission (Level 1 approximation)
  const ibIdeal = If / BF + Ir / BR;
  const ibNonIdeal =
    (ISE > 0 ? ISE * (expVbe - 1) : 0) +
    (ISC > 0 ? ISC * (expVbc - 1) : 0);
  const ib = ibIdeal + ibNonIdeal;

  // Linearized conductances via chain rule
  // dIf/dVbe = IS * exp(Vbe/nfVt) / nfVt
  const dIfdVbe = IS * expVbe / nfVt;
  // dIr/dVbc = IS * exp(Vbc/nrVt) / nrVt
  const dIrdVbc = IS * expVbc / nrVt;

  // dqb/dVbe and dqb/dVbc (Early effect + high injection Jacobian)
  const sqrtTerm = Math.sqrt(Math.max(1 + 4 * q2, 1e-30));
  const dqbdIf = q1 / sqrtTerm / (IKF === Infinity ? 1e30 : IKF);
  const dqbdIr = q1 / sqrtTerm / (IKR === Infinity ? 1e30 : IKR);

  const VAF_safe = VAF === Infinity ? 1e30 : VAF;
  const VAR_safe = VAR === Infinity ? 1e30 : VAR;
  const dq1dVbe = q1 * q1 / VAF_safe;
  const dq1dVbc = q1 * q1 / VAR_safe;
  const dqbdVbe = dq1dVbe * (1 + sqrtTerm) / 2 + dqbdIf * dIfdVbe;
  const dqbdVbc = dq1dVbc * (1 + sqrtTerm) / 2 + dqbdIr * dIrdVbc;

  // d(ic)/dVbe = dIf/dVbe/qb - (If-Ir)*dqb/dVbe/qb^2
  const gm = dIfdVbe / qb - ic * dqbdVbe / qb + GMIN;
  // d(ic)/dVbc = -dIr/dVbc/qb - (If-Ir)*dqb/dVbc/qb^2
  // go = d(Ic)/d(Vce) = d(Ic)/d(Vbc) (since Vce = Vbe - Vbc)
  const go = dIrdVbc / qb + ic * dqbdVbc / qb + GMIN;

  // d(ib)/dVbe = dIf/(BF*nfVt) + ISE*exp(Vbe/nfVt)/nfVt
  const gpi = dIfdVbe / BF + (ISE > 0 ? ISE * expVbe / nfVt : 0) + GMIN;
  // d(ib)/dVbc = dIr/(BR*nrVt) + ISC*exp(Vbc/nrVt)/nrVt
  const gmu = dIrdVbc / BR + (ISC > 0 ? ISC * expVbc / nrVt : 0) + GMIN;

  return { vbe, vbc, ic, ib, gm, go, gpi, gmu };
}

// ---------------------------------------------------------------------------
// createBjtElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createBjtElement(
  polarity: 1 | -1,
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeC = nodeIds[0]; // collector
  const nodeB = nodeIds[1]; // base
  const nodeE = nodeIds[2]; // emitter

  // Resolve model parameters
  const modelParams =
    (props as Record<string, unknown>)["_modelParams"] as Record<string, number> | undefined;
  const defaults = polarity === 1 ? BJT_NPN_DEFAULTS : BJT_PNP_DEFAULTS;
  const mp = modelParams ?? defaults;

  const IS = mp["IS"] ?? defaults["IS"];
  const BF = mp["BF"] ?? defaults["BF"];
  const NF = mp["NF"] ?? defaults["NF"];
  const BR = mp["BR"] ?? defaults["BR"];
  const NR = mp["NR"] ?? defaults["NR"];
  const ISE = mp["ISE"] ?? defaults["ISE"];
  const ISC = mp["ISC"] ?? defaults["ISC"];
  const VAF = mp["VAF"] ?? defaults["VAF"];
  const VAR = mp["VAR"] ?? defaults["VAR"];
  const IKF = mp["IKF"] ?? defaults["IKF"];
  const IKR = mp["IKR"] ?? defaults["IKR"];

  const nfVt = NF * VT;
  const nrVt = NR * VT;
  const vcritBE = nfVt * Math.log(nfVt / (IS * Math.SQRT2));
  const vcritBC = nrVt * Math.log(nrVt / (IS * Math.SQRT2));

  // Operating point state (initialized to zero = all junctions at 0V)
  let vbe = 0;
  let vbc = 0;
  let op: BjtOperatingPoint = computeBjtOp(
    vbe, vbc, IS, BF, NF, BR, NR, ISE, ISC, VAF, VAR, IKF, IKR,
  );

  return {
    nodeIndices: [nodeC, nodeB, nodeE],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear (topology-constant) contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      // The BJT equivalent circuit (linearized Gummel-Poon) has:
      //   - Conductance gpi between B and E
      //   - Conductance gmu between B and C
      //   - Conductance go between C and E
      //   - VCCS gm*Vbe: current from E to C
      //
      // Norton equivalents at each node:
      //   Ic_norton = ic - gm*vbe - go*vbc
      //   Ib_norton = ib - gpi*vbe - gmu*vbc
      //   Ie_norton = -(ic + ib) - (-gpi*vbe - gmu*vbc - gm*vbe - go*vbc)

      const { ic, ib, gm, go, gpi, gmu } = op;
      const vbeOp = op.vbe;
      const vbcOp = op.vbc;

      // Norton current sources (using polarity-signed operating point voltages)
      const icNorton = ic - gm * vbeOp + go * vbcOp;
      const ibNorton = ib - gpi * vbeOp - gmu * vbcOp;
      const ieNorton = -(ic + ib) + gm * vbeOp - go * vbcOp + gpi * vbeOp + gmu * vbcOp;

      // Stamp conductances (gpi between B-E, gmu between B-C, go between C-E)
      // gpi between B and E
      stampG(solver, nodeB, nodeB, gpi);
      stampG(solver, nodeB, nodeE, -gpi);
      stampG(solver, nodeE, nodeB, -gpi);
      stampG(solver, nodeE, nodeE, gpi);

      // gmu between B and C
      stampG(solver, nodeB, nodeB, gmu);
      stampG(solver, nodeB, nodeC, -gmu);
      stampG(solver, nodeC, nodeB, -gmu);
      stampG(solver, nodeC, nodeC, gmu);

      // go between C and E
      stampG(solver, nodeC, nodeC, go);
      stampG(solver, nodeC, nodeE, -go);
      stampG(solver, nodeE, nodeC, -go);
      stampG(solver, nodeE, nodeE, go);

      // gm*vbe transconductance: gm stamps in C-E cross terms
      // The VCCS gm*Vbe adds gm to the [C,B] position and -gm to [C,E] and
      // -gm to [E,B] and gm to [E,E] (since Vbe = Vb - Ve)
      stampG(solver, nodeC, nodeB, gm);
      stampG(solver, nodeC, nodeE, -gm);
      stampG(solver, nodeE, nodeB, -gm);
      stampG(solver, nodeE, nodeE, gm);

      // Norton RHS at each terminal
      stampRHS(solver, nodeC, -polarity * icNorton);
      stampRHS(solver, nodeB, -polarity * ibNorton);
      stampRHS(solver, nodeE, -polarity * ieNorton);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      // Read node voltages
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;

      // Junction voltages (polarity-corrected for PNP)
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      // Apply pnjlim to both junctions
      const vbeLimited = pnjlim(vbeRaw, vbe, nfVt, vcritBE);
      const vbcLimited = pnjlim(vbcRaw, vbc, nrVt, vcritBC);

      // Write limited voltages back
      // For NPN: vB - vE = vbeLimited → adjust vB
      // For PNP: polarity*(vB - vE) = vbeLimited → vB - vE = vbeLimited/polarity
      if (nodeB > 0) {
        voltages[nodeB - 1] = vE + vbeLimited * polarity;
      }

      vbe = vbeLimited;
      vbc = vbcLimited;

      op = computeBjtOp(vbe, vbc, IS, BF, NF, BR, NR, ISE, ISC, VAF, VAR, IKF, IKR);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;
      const vbeNew = polarity * (vB - vE);
      const vbcNew = polarity * (vB - vC);

      const vCp = nodeC > 0 ? prevVoltages[nodeC - 1] : 0;
      const vBp = nodeB > 0 ? prevVoltages[nodeB - 1] : 0;
      const vEp = nodeE > 0 ? prevVoltages[nodeE - 1] : 0;
      const vbePrev = polarity * (vBp - vEp);
      const vbcPrev = polarity * (vBp - vCp);

      return (
        Math.abs(vbeNew - vbePrev) <= 2 * nfVt &&
        Math.abs(vbcNew - vbcPrev) <= 2 * nrVt
      );
    },
  };
}

// ---------------------------------------------------------------------------
// NpnBjtElement + PnpBjtElement — CircuitElement implementations
// ---------------------------------------------------------------------------

export class NpnBjtElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NpnBJT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNpnPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.5,
      y: this.position.y - 1.5,
      width: 3,
      height: 3,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body circle
    ctx.drawCircle(1, 0, 1.2, false);

    // Base lead (left)
    ctx.drawLine(0, 0, 1, 0);
    // Vertical base line inside circle
    ctx.drawLine(1, -0.8, 1, 0.8);

    // Collector lead (top-right) — from base line to collector pin
    ctx.drawLine(1, -0.8, 2, -1.5);

    // Emitter lead (bottom-right) with arrow
    ctx.drawLine(1, 0.8, 2, 1.5);
    // Arrow on emitter (pointing out for NPN)
    ctx.drawPolygon([
      { x: 1.6, y: 1.1 },
      { x: 1.8, y: 1.3 },
      { x: 1.4, y: 1.35 },
    ], true);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1, -1.8, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "NPN BJT — Gummel-Poon Level 2 bipolar junction transistor.\n" +
      "Pins: C (collector), B (base), E (emitter).\n" +
      "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR."
    );
  }
}

export class PnpBjtElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PnpBJT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPnpPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.5,
      y: this.position.y - 1.5,
      width: 3,
      height: 3,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body circle
    ctx.drawCircle(1, 0, 1.2, false);

    // Base lead (left)
    ctx.drawLine(0, 0, 1, 0);
    ctx.drawLine(1, -0.8, 1, 0.8);

    // Collector lead (top-right)
    ctx.drawLine(1, -0.8, 2, -1.5);

    // Emitter lead (bottom-right) with arrow pointing IN (PNP)
    ctx.drawLine(1, 0.8, 2, 1.5);
    ctx.drawPolygon([
      { x: 1.4, y: 1.1 },
      { x: 1.6, y: 1.3 },
      { x: 1.2, y: 1.3 },
    ], true);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1, -1.8, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "PNP BJT — Gummel-Poon Level 2 bipolar junction transistor.\n" +
      "Pins: C (collector), B (base), E (emitter).\n" +
      "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR."
    );
  }
}

// ---------------------------------------------------------------------------
// Pin layouts
// ---------------------------------------------------------------------------

function buildNpnPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 2, y: -1.5 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "E",
      defaultBitWidth: 1,
      position: { x: 2, y: 1.5 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

function buildPnpPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 2, y: -1.5 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "E",
      defaultBitWidth: 1,
      position: { x: 2, y: 1.5 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BJT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "model",
    type: PropertyType.STRING,
    label: "Model",
    defaultValue: "",
    description: "SPICE model name (blank = use built-in defaults)",
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

export const BJT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "model",
    propertyKey: "model",
    convert: (v) => v,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

function npnCircuitFactory(props: PropertyBag): NpnBjtElement {
  return new NpnBjtElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function pnpCircuitFactory(props: PropertyBag): PnpBjtElement {
  return new PnpBjtElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NpnBjtDefinition: ComponentDefinition = {
  name: "NpnBJT",
  typeId: -1,
  engineType: "analog",
  factory: npnCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildNpnPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "NPN BJT — Gummel-Poon Level 2 bipolar junction transistor.\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  analogDeviceType: "NPN",
  analogFactory: (nodeIds, branchIdx, props, _getTime) =>
    createBjtElement(1, nodeIds, branchIdx, props),
};

export const PnpBjtDefinition: ComponentDefinition = {
  name: "PnpBJT",
  typeId: -1,
  engineType: "analog",
  factory: pnpCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildPnpPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "PNP BJT — Gummel-Poon Level 2 bipolar junction transistor (PNP polarity).\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  analogDeviceType: "PNP",
  analogFactory: (nodeIds, branchIdx, props, _getTime) =>
    createBjtElement(-1, nodeIds, branchIdx, props),
};
