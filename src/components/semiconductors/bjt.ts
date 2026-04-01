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
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q). */
const VT = 0.02585;

/** Minimum conductance for numerical stability. */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-14,  unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,      description: "Forward emission coefficient" },
    BR:  { default: 1,      description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
    IKF: { default: Infinity, unit: "A", description: "Forward knee current" },
    IKR: { default: Infinity, unit: "A", description: "Reverse knee current" },
    ISE: { default: 0,      unit: "A", description: "B-E leakage saturation current" },
    ISC: { default: 0,      unit: "A", description: "B-C leakage saturation current" },
    NR:  { default: 1,      description: "Reverse emission coefficient" },
    VAR: { default: Infinity, unit: "V", description: "Reverse Early voltage" },
  },
});

export const { defaults: BJT_PNP_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-14,  unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,      description: "Forward emission coefficient" },
    BR:  { default: 1,      description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
    IKF: { default: Infinity, unit: "A", description: "Forward knee current" },
    IKR: { default: Infinity, unit: "A", description: "Reverse knee current" },
    ISE: { default: 0,      unit: "A", description: "B-E leakage saturation current" },
    ISC: { default: 0,      unit: "A", description: "B-C leakage saturation current" },
    NR:  { default: 1,      description: "Reverse emission coefficient" },
    VAR: { default: Infinity, unit: "V", description: "Reverse Early voltage" },
  },
});

// ---------------------------------------------------------------------------
// Built-in NPN model presets
// Sources: Fairchild/Philips/NXP extracted models from LTspice standard.bjt
// ---------------------------------------------------------------------------

/** Small signal general purpose NPN. Source: Fairchild extracted. */
const NPN_2N3904: Record<string, number> = {
  IS: 6.734e-15, BF: 416.4, NF: 1.0, BR: 0.7371, NR: 1.0,
  VAF: 74.03, IKF: 0.06678, IKR: 0, ISE: 6.734e-15, ISC: 0, VAR: 100,
};

/** Small signal NPN (European, B-grade). Source: NXP extracted. */
const NPN_BC547B: Record<string, number> = {
  IS: 2.39e-14, BF: 294.3, NF: 1.008, BR: 7.946, NR: 1.004,
  VAF: 63.2, IKF: 0.1357, IKR: 0.1144, ISE: 3.545e-15, ISC: 6.272e-14, VAR: 25.9,
};

/** General purpose NPN. Source: Fairchild extracted. */
const NPN_2N2222A: Record<string, number> = {
  IS: 14.34e-15, BF: 255.9, NF: 1.0, BR: 6.092, NR: 1.0,
  VAF: 74.03, IKF: 0.2847, IKR: 0, ISE: 14.34e-15, ISC: 0, VAR: 100,
};

/** Medium power NPN (TO-39, same die as 2N2222A). Source: Philips/LTspice. */
const NPN_2N2219A: Record<string, number> = {
  IS: 14.34e-15, BF: 255.9, NF: 1.0, BR: 6.092, NR: 1.0,
  VAF: 74.03, IKF: 0.2847, IKR: 0, ISE: 14.34e-15, ISC: 0, VAR: 100,
};

// ---------------------------------------------------------------------------
// Built-in PNP model presets
// Sources: Fairchild/Philips/NXP extracted models, Central Semiconductor
// ---------------------------------------------------------------------------

/** Small signal PNP (complement of 2N3904). Source: Fairchild extracted. */
const PNP_2N3906: Record<string, number> = {
  IS: 1.41e-15, BF: 180.7, NF: 1.0, BR: 4.977, NR: 1.0,
  VAF: 18.7, IKF: 0.08, IKR: 0, ISE: 0, ISC: 0, VAR: 100,
};

/** Small signal PNP (European, B-grade, complement of BC547B). Source: NXP extracted. */
const PNP_BC557B: Record<string, number> = {
  IS: 3.83e-14, BF: 344.4, NF: 1.008, BR: 14.84, NR: 1.005,
  VAF: 21.11, IKF: 0.08039, IKR: 0.047, ISE: 1.22e-14, ISC: 2.85e-13, VAR: 32.02,
};

/** General purpose PNP (complement of 2N2222). Source: Philips extracted. */
const PNP_2N2907A: Record<string, number> = {
  IS: 650.6e-18, BF: 231.7, NF: 1.0, BR: 3.563, NR: 1.0,
  VAF: 115.7, IKF: 1.079, IKR: 0, ISE: 54.81e-15, ISC: 0, VAR: 100,
};

/** Medium power PNP. Source: Central Semiconductor Corp TIP32C.LIB. */
const PNP_TIP32C: Record<string, number> = {
  IS: 1.8111e-12, BF: 526.98, NF: 1.0, BR: 1.1294, NR: 1.0,
  VAF: 100, IKF: 0.95034, IKR: 0.15869, ISE: 68.670e-12, ISC: 409.26e-9, VAR: 100,
};

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------


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
  pinNodes: ReadonlyMap<string, number>,
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeB = pinNodes.get("B")!; // base
  const nodeC = pinNodes.get("C")!; // collector
  const nodeE = pinNodes.get("E")!; // emitter

  // Read model parameters from the PropertyBag model param partition.
  // Guaranteed populated by compiler via replaceModelParams() before factory invocation.
  const params: Record<string, number> = {
    IS: props.getModelParam<number>("IS"),
    BF: props.getModelParam<number>("BF"),
    NF: props.getModelParam<number>("NF"),
    BR: props.getModelParam<number>("BR"),
    NR: props.getModelParam<number>("NR"),
    ISE: props.getModelParam<number>("ISE"),
    ISC: props.getModelParam<number>("ISC"),
    VAF: props.getModelParam<number>("VAF"),
    VAR: props.getModelParam<number>("VAR"),
    IKF: props.getModelParam<number>("IKF"),
    IKR: props.getModelParam<number>("IKR"),
  };

  // Operating point state (initialized to zero = all junctions at 0V)
  let vbe = 0;
  let vbc = 0;
  let op: BjtOperatingPoint = computeBjtOp(
    vbe, vbc,
    params.IS, params.BF, params.NF, params.BR, params.NR,
    params.ISE, params.ISC, params.VAF, params.VAR, params.IKF, params.IKR,
  );

  return {
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

      // Recompute derived values from mutable params
      const nfVt = params.NF * VT;
      const nrVt = params.NR * VT;
      const vcritBE = nfVt * Math.log(nfVt / (params.IS * Math.SQRT2));
      const vcritBC = nrVt * Math.log(nrVt / (params.IS * Math.SQRT2));

      // Junction voltages (polarity-corrected for PNP)
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      // Apply pnjlim to both junctions independently
      const vbeLimited = pnjlim(vbeRaw, vbe, nfVt, vcritBE);
      const vbcLimited = pnjlim(vbcRaw, vbc, nrVt, vcritBC);

      // Write limited voltages back into the solution vector consistently.
      // Both junctions share the base node, so we must adjust vB AND vC
      // to enforce both limits simultaneously (keep vE as the anchor).
      // Original bug: only vB was adjusted for vbe, silently corrupting vbc.
      if (nodeB > 0) {
        voltages[nodeB - 1] = vE + vbeLimited * polarity;
      }
      if (nodeC > 0) {
        // vbc = polarity*(vB'-vC) = vbcLimited → vC = vB' - vbcLimited*polarity
        const vBnew = nodeB > 0 ? voltages[nodeB - 1] : vE + vbeLimited * polarity;
        voltages[nodeC - 1] = vBnew - vbcLimited * polarity;
      }

      vbe = vbeLimited;
      vbc = vbcLimited;

      op = computeBjtOp(
        vbe, vbc,
        params.IS, params.BF, params.NF, params.BR, params.NR,
        params.ISE, params.ISC, params.VAF, params.VAR, params.IKF, params.IKR,
      );
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

      const nfVt = params.NF * VT;
      const nrVt = params.NR * VT;
      return (
        Math.abs(vbeNew - vbePrev) <= 2 * nfVt &&
        Math.abs(vbcNew - vbcPrev) <= 2 * nrVt
      );
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinNodeIds order: [nodeB, nodeC, nodeE] (pinLayout order: [B, C, E])
      // Positive = current flowing INTO element at that pin.
      const ic = polarity * op.ic;
      const ib = polarity * op.ib;
      const ie = -(ic + ib); // KCL: ib + ic + ie = 0
      return [ib, ic, ie];
    },

    setParam(key: string, value: number): void {
      if (key in params) params[key] = value;
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
      x: this.position.x,
      y: this.position.y - 1,
      width: 4.0,
      height: 2.0,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vB = signals?.getPinVoltage("B");
    const vC = signals?.getPinVoltage("C");
    const vE = signals?.getPinVoltage("E");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Vertical bar (filled polygon)
    ctx.drawPolygon([
      { x: 3, y: -1 },
      { x: 3.1875, y: -1 },
      { x: 3.1875, y: 1 },
      { x: 3, y: 1 },
    ], true);

    // Base lead
    drawColoredLead(ctx, signals, vB, 0, 0, 3, 0);

    // Collector lead (from bar to collector pin)
    drawColoredLead(ctx, signals, vC, 3.1875, -0.375, 4, -1);

    // Emitter lead (from bar to emitter pin)
    drawColoredLead(ctx, signals, vE, 3.1875, 0.375, 4, 1);

    // Arrow on emitter (pointing outward for NPN)
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 4, y: 1 },
      { x: 3.75, y: 0.5 },
      { x: 3.4375, y: 0.875 },
    ], true);

    ctx.restore();
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
      x: this.position.x,
      y: this.position.y - 1,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vB = signals?.getPinVoltage("B");
    const vC = signals?.getPinVoltage("C");
    const vE = signals?.getPinVoltage("E");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Vertical bar (filled polygon)
    ctx.drawPolygon([
      { x: 3, y: -1 },
      { x: 3.1875, y: -1 },
      { x: 3.1875, y: 1 },
      { x: 3, y: 1 },
    ], true);

    // Base lead
    drawColoredLead(ctx, signals, vB, 0, 0, 3, 0);

    // Lower branch to C pin at (4, 1)
    drawColoredLead(ctx, signals, vC, 3.1875, 0.375, 4, 1);

    // Upper branch to E pin at (4, -1)
    drawColoredLead(ctx, signals, vE, 3.1875, -0.375, 4, -1);

    // Arrow on upper (E) branch pointing inward (PNP)
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 3.3125, y: -0.3125 },
      { x: 3.8125, y: -0.5 },
      { x: 3.5, y: -0.875 },
    ], true);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layouts
// ---------------------------------------------------------------------------

function buildNpnPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "E",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

function buildPnpPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "E",
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

const BJT_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
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
  factory: npnCircuitFactory,
  pinLayout: buildNpnPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "NPN BJT — Gummel-Poon Level 2 bipolar junction transistor.\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: BJT_NPN_DEFAULTS,
    },
    "2N3904": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: NPN_2N3904,
    },
    "BC547B": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: NPN_BC547B,
    },
    "2N2222A": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: NPN_2N2222A,
    },
    "2N2219A": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: NPN_2N2219A,
    },
  },
  defaultModel: "behavioral",
};

export const PnpBjtDefinition: ComponentDefinition = {
  name: "PnpBJT",
  typeId: -1,
  factory: pnpCircuitFactory,
  pinLayout: buildPnpPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "PNP BJT — Gummel-Poon Level 2 bipolar junction transistor (PNP polarity).\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(-1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: BJT_PNP_DEFAULTS,
    },
    "2N3906": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(-1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: PNP_2N3906,
    },
    "BC557B": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(-1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: PNP_BC557B,
    },
    "2N2907A": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(-1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: PNP_2N2907A,
    },
    "TIP32C": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(-1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: PNP_TIP32C,
    },
  },
  defaultModel: "behavioral",
};
