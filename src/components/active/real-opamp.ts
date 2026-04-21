/**
 * Real Op-Amp composite model.
 *
 * Extends the ideal op-amp with physically realistic effects:
 *   - Finite open-loop gain (A_OL)
 *   - Finite gain-bandwidth product (GBW) — single-pole first-order rolloff
 *   - Input offset voltage (V_os)
 *   - Input bias current (I_bias) at both inputs
 *   - Input resistance (R_in)
 *   - Slew rate limiting (clamped integrator)
 *   - Output resistance (R_out)
 *   - Output current limiting (|I_out| ≤ I_max)
 *   - Rail saturation (output clamps to V_supply ± V_sat)
 *
 * Implementation strategy — single-pole rolloff as a companion-model integrator:
 *   The gain stage is modelled as a first-order low-pass filter on V_diff.
 *   An internal node V_int integrates toward A_OL * (V_diff + V_os) with
 *   time constant τ = A_OL / (2π * GBW).  In MNA this becomes a capacitor
 *   companion model:  C_eq = τ * G_int,  where G_int = 1/R_int (a small
 *   internal resistance chosen for numerical stability).
 *
 *   For DC analysis the integrator settles and V_int = A_OL * V_diff (ideal
 *   VCVS), which is exactly what we want.
 *
 * Slew rate:
 *   At each timestep the change in V_int is clamped to SR * dt.  When
 *   clamped, the integrator current is limited accordingly.
 *
 * .MODEL support:
 *   Standard op-amp models (741, LM358, TL072, OPA2134) are pre-defined.
 *   Keys in the model params record:
 *     A    — open-loop gain (default 100000)
 *     GBW  — gain-bandwidth product in Hz (default 1e6)
 *     SR   — slew rate in V/s (default 0.5e6)
 *     Vos  — input offset voltage in V (default 1e-3)
 *     Ibias — input bias current in A (default 80e-9)
 *
 * Node layout passed to analogFactory:
 *   [0] = in+   (non-inverting input)
 *   [1] = in-   (inverting input)
 *   [2] = out   (output)
 *   [3] = Vcc+  (positive supply)
 *   [4] = Vcc-  (negative supply)
 *   [5] = V_int (internal gain-stage node — allocated by analog compiler)
 *
 * branchIdx is -1 (no extra MNA branch rows needed; the output is a Norton
 * equivalent, not a voltage-source branch).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { MODETRAN } from "../../solver/analog/ckt-mode.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
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
    rOut:     { default: 75,    unit: "Ω",   description: "Output resistance" },
    iMax:     { default: 25e-3, unit: "A",   description: "Output current limit" },
    vSatPos:  { default: 1.5,   unit: "V",   description: "Positive rail saturation drop" },
    vSatNeg:  { default: 1.5,   unit: "V",   description: "Negative rail saturation drop" },
  },
});

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
// RealOpAmpElement — CircuitElement
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

    // Triangle body — stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [{ x: triLeft, y: -2 }, { x: triRight, y: 0 }, { x: triLeft, y: 2 }],
      false,
    );

    // Supply rail stubs: Vcc+ stub
    drawColoredLead(ctx, signals, vVccP, 2, -2, 2, -1);

    // Supply rail stubs: Vcc- stub
    drawColoredLead(ctx, signals, vVccN, 2, 2, 2, 1);

    // +/- signs — body decoration, stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText('-', 13 / 16, -18 / 16, { horizontal: "center", vertical: "middle" });
    ctx.drawText('+', 13 / 16, 16 / 16, { horizontal: "center", vertical: "middle" });

    // Supply pin labels
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("V+", 2.4, -1.0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("V\u2212", 2.4, 1.0, { horizontal: "left", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// createRealOpAmpElement — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for a real op-amp.
 *
 * Node assignment (1-based, 0 = ground):
 *   nodeIds[0] = in+   (non-inverting input)
 *   nodeIds[1] = in-   (inverting input)
 *   nodeIds[2] = out   (output)
 *   nodeIds[3] = Vcc+  (positive supply)
 *   nodeIds[4] = Vcc-  (negative supply)
 *
 * MNA formulation — Norton/VCVS hybrid with proper Jacobian:
 *
 * Input stage:
 *   - R_in conductance between in+ and in-
 *   - Bias current sources I_bias stamped at the input nodes
 *
 * Gain stage (DC: same as ideal op-amp VCVS; transient: companion integrator):
 *
 *   In the unsaturated, non-current-limited region the gain stage provides:
 *     V_out = A_eff * (V_diff + V_os)
 *   where A_eff = aol in DC, and is modified by the companion integrator in transient.
 *
 *   The NR linearization at operating point (Vinp0, Vinn0, Vout0):
 *     MNA row for out:
 *       G[out,out] += G_out
 *       G[out,in+] -= A_eff * G_out           (Jacobian: output depends on in+)
 *       G[out,in-] += A_eff * G_out           (Jacobian: output depends on in-)
 *       RHS[out]   += G_out * (V_int - A_eff * (Vinp0 - Vinn0))
 *
 *   This is the standard NR linearization: f(x) = f(x0) + f'(x0)*(x-x0).
 *   The Jacobian entries allow NR to find the virtual-ground solution in one
 *   or a few iterations, exactly as for the ideal op-amp.
 *
 *   V_int is an internal state variable that tracks the gain-stage output
 *   voltage with slew-rate clamping and rail saturation applied.
 *
 * Saturation:
 *   When V_out ≥ V_supply+ - V_sat or V_out ≤ V_supply- + V_sat:
 *   the Jacobian coupling is zeroed and a Norton current drives V_out to rail.
 *
 * Current limiting:
 *   When |I_out| > I_max: inject a constant current ±I_max instead.
 *
 * Transient:
 *   A_eff is reduced by the companion integrator's bandwidth-limiting factor.
 *   The effective gain at frequency ω is A_OL / (1 + jω*τ), implemented as
 *   a first-order BDF-1 update of V_int each timestep with slew-rate clamping.
 */
export function createRealOpAmpElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElementCore {
  // Extract parameters from model param partition
  const p: Record<string, number> = {
    aol:      props.getModelParam<number>("aol"),
    gbw:      props.getModelParam<number>("gbw"),
    slewRate: props.getModelParam<number>("slewRate"),
    vos:      props.getModelParam<number>("vos"),
    iBias:    props.getModelParam<number>("iBias"),
    rIn:      props.getModelParam<number>("rIn"),
    rOut:     props.getModelParam<number>("rOut"),
    iMax:     props.getModelParam<number>("iMax"),
    vSatPos:  props.getModelParam<number>("vSatPos"),
    vSatNeg:  props.getModelParam<number>("vSatNeg"),
  };

  // Apply named model overrides if specified
  const modelName = props.getOrDefault<string>("model", "");
  if (modelName.length > 0) {
    const preset = REAL_OPAMP_MODELS[modelName];
    if (preset) {
      p.aol      = preset.aol;
      p.gbw      = preset.gbw;
      p.slewRate = preset.slewRate;
      p.vos      = preset.vos;
      p.iBias    = preset.iBias;
    }
  }

  const nInn  = pinNodes.get("in-")!;  // inverting input
  const nInp  = pinNodes.get("in+")!;  // non-inverting input
  const nOut  = pinNodes.get("out")!;  // output
  const nVccP = pinNodes.get("Vcc+")!; // positive supply
  const nVccN = pinNodes.get("Vcc-")!; // negative supply

  // Internal gain-stage state — not an MNA node.
  // Updated each NR iteration inside load().
  let vInt = 0;

  // Operating point voltages
  let vInp  = 0;
  let vInn  = 0;
  let vVccP = 15;
  let vVccN = -15;
  let vOut  = 0;

  // Saturation state (determined from V_out)
  let outputSaturated  = false;
  let outputClampLevel = 0;

  // Current limiting state
  let currentLimited = false;
  let iOutLimited    = 0;

  // Slew rate limiting state (transient only)
  let slewLimited = false;
  let _vOutPrev = 0; void _vOutPrev;      // output voltage at previous accepted timestep

  // Source scale for source-stepping DC convergence — read from ctx.srcFact
  // (ngspice CKTsrcFact) in load() and cached for getPinCurrents().
  let lastSrcFact = 1;

  // Transient: effective gain reduced from A_OL by bandwidth limiting.
  // In DC mode (no companion): aEff = p.aol. In transient: aEff < p.aol.
  let aEff = p.aol;

  // BDF-1 companion model for the gain-stage integrator.
  // geq_int > 0 only during transient; 0 during DC.
  let geq_int  = 0;
  let vIntPrev = 0;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  function stampCond(
    solver: SparseSolver,
    nA: number,
    nB: number,
    g: number,
  ): void {
    if (nA > 0) solver.stampElement(solver.allocElement(nA - 1, nA - 1), g);
    if (nB > 0) solver.stampElement(solver.allocElement(nB - 1, nB - 1), g);
    if (nA > 0 && nB > 0) {
      solver.stampElement(solver.allocElement(nA - 1, nB - 1), -g);
      solver.stampElement(solver.allocElement(nB - 1, nA - 1), -g);
    }
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.voltages;
      const scale = ctx.srcFact;
      lastSrcFact = scale;
      const G_in   = 1 / Math.max(p.rIn,  1e-9);
      const G_out  = 1 / Math.max(p.rOut, 1e-9);
      const iMax   = Math.max(p.iMax,   1e-12);
      const vSatPos = Math.max(p.vSatPos, 0);
      const vSatNeg = Math.max(p.vSatNeg, 0);
      const aol    = Math.max(p.aol, 1);

      // Update companion coefficient at the start of each NR iteration.
      // During transient NR: geq_int = tau/dt. During DC: geq_int = 0 (no
      // history term, pure VCVS).
      if ((ctx.cktMode & MODETRAN) && ctx.dt > 0) {
        const tau = aol / (2 * Math.PI * Math.max(p.gbw, 1));
        geq_int = tau / ctx.dt;
      } else {
        geq_int = 0;
      }

      // Evaluate operating point from current NR-iterate voltages.
      vInp  = readNode(voltages, nInp);
      vInn  = readNode(voltages, nInn);
      vVccP = readNode(voltages, nVccP);
      vVccN = readNode(voltages, nVccN);
      vOut  = readNode(voltages, nOut);

      const vDiff = vInp - vInn;
      const vOsScaled = p.vos * scale;

      const vRailPos = vVccP - vSatPos;
      const vRailNeg = vVccN + vSatNeg;

      if (geq_int > 0) {
        // Transient: re-evaluate slew state from current NR-iterate voltages.
        const g = geq_int;
        const tau = aol / (2 * Math.PI * Math.max(p.gbw, 1));
        const dt = tau / g;
        const slewLimit = Math.max(p.slewRate, 1e-6) * dt;
        const target = (aol * (vDiff + vOsScaled) + g * vIntPrev) / (1 + g);
        const delta = target - vIntPrev;
        const clampedDelta = Math.max(-slewLimit, Math.min(slewLimit, delta));
        slewLimited = Math.abs(delta) > slewLimit;
        vInt = vIntPrev + clampedDelta;
        aEff = slewLimited ? 0 : aol / (1 + g);

        if (vVccP > vVccN) {
          vInt = Math.max(vRailNeg, Math.min(vRailPos, vInt));
        } else {
          vInt = Math.max(-1000, Math.min(1000, vInt));
        }
      } else {
        vInt = aol * (vDiff + vOsScaled);
        aEff = aol;
        slewLimited = false;
        if (vVccP > vVccN) {
          vInt = Math.max(vRailNeg, Math.min(vRailPos, vInt));
        } else {
          vInt = Math.max(-1000, Math.min(1000, vInt));
        }
      }

      if (vVccP > vVccN && vOut >= vRailPos) {
        outputSaturated  = true;
        outputClampLevel = vRailPos;
      } else if (vVccP > vVccN && vOut <= vRailNeg) {
        outputSaturated  = true;
        outputClampLevel = vRailNeg;
      } else {
        outputSaturated  = false;
        outputClampLevel = 0;
      }

      if (outputSaturated) {
        const iOutNow = (outputClampLevel - vOut) * G_out;
        if (Math.abs(iOutNow) > iMax) {
          currentLimited = true;
          iOutLimited    = iOutNow > 0 ? iMax : -iMax;
        } else {
          currentLimited = false;
          iOutLimited    = 0;
        }
      } else {
        currentLimited = false;
        iOutLimited    = 0;
      }

      // Linear topology stamps:
      // Input resistance between in+ and in-
      stampCond(solver, nInp, nInn, G_in);
      // Output conductance G_out (always present for NR stability)
      if (nOut > 0) {
        solver.stampElement(solver.allocElement(nOut - 1, nOut - 1), G_out);
      }

      // Input bias currents
      const iBiasScaled = Math.abs(p.iBias) * scale;
      if (nInp > 0) solver.stampRHS(nInp - 1, -iBiasScaled);
      if (nInn > 0) solver.stampRHS(nInn - 1, -iBiasScaled);

      if (nOut <= 0) return;

      // Gain-stage output
      if (outputSaturated) {
        solver.stampRHS(nOut - 1, outputClampLevel * G_out);
      } else if (currentLimited) {
        solver.stampRHS(nOut - 1, iOutLimited);
      } else if (slewLimited) {
        solver.stampRHS(nOut - 1, vInt * G_out);
      } else {
        // Normal operation: bandwidth-limited VCVS with BDF-1 history current.
        const aEffScaled = aEff * scale;
        const ieq = geq_int > 0
          ? (geq_int / (1 + geq_int)) * vIntPrev * G_out
          : 0;
        if (nInp > 0) solver.stampElement(solver.allocElement(nOut - 1, nInp - 1), -aEffScaled * G_out);
        if (nInn > 0) solver.stampElement(solver.allocElement(nOut - 1, nInn - 1), aEffScaled * G_out);
        solver.stampRHS(nOut - 1, ieq + aEffScaled * G_out * p.vos * scale);
      }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      // Record the accepted-timestep vInt and output voltage so the next
      // step's BDF-1 history term uses the converged state.
      vIntPrev = vInt;
      _vOutPrev = readNode(ctx.voltages, nOut);
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: in-, in+, out, Vcc+, Vcc-
      //
      // Input resistance G_in is stamped between nInp and nInn.
      // Current into element at each input terminal from the resistor:
      //   I_resistor_at_nInn = (vInn - vInp) * G_in
      //   I_resistor_at_nInp = (vInp - vInn) * G_in
      // Bias currents: stampRHS injects -iBias into each node → element draws +iBias.
      //
      // Output (Norton equivalent, G_out stamped on diagonal to ground):
      //   Normal/slewing:        Norton target = vInt → I_out = (vOut - vInt) * G_out
      //   Saturated (no limit):  Norton target = outputClampLevel → I_out = (vOut - outputClampLevel) * G_out
      //   Current limited:       RHS carries iOutLimited directly (injects INTO node)
      //                          → element draws -iOutLimited; diagonal G_out drives to ground
      //                          → I_out = vOut * G_out - iOutLimited
      //
      // Supply pins: by KCL the sum of all 5 pin currents must be zero.
      // Total supply current = -(I_inn + I_inp + I_out).
      // Split by output polarity: Vcc+ provides current when output sources,
      // Vcc- sinks current when output sinks.

      const G_in  = 1 / Math.max(p.rIn,  1e-9);
      const G_out = 1 / Math.max(p.rOut, 1e-9);
      const iBiasScaled = Math.abs(p.iBias) * lastSrcFact;

      // Input pin currents (resistor + bias)
      const iInn = (nInn > 0 ? (vInn - vInp) * G_in : 0) + iBiasScaled;
      const iInp = (nInp > 0 ? (vInp - vInn) * G_in : 0) + iBiasScaled;

      // Output pin current (into element)
      let iOut: number;
      if (nOut <= 0) {
        iOut = 0;
      } else if (currentLimited) {
        // G_out diagonal stamps V_out to ground effectively; RHS carries iOutLimited
        // into node. Current into element = vOut * G_out - iOutLimited.
        iOut = vOut * G_out - iOutLimited;
      } else if (outputSaturated) {
        iOut = (vOut - outputClampLevel) * G_out;
      } else {
        // Normal or slewing: Norton target = vInt
        iOut = (vOut - vInt) * G_out;
      }

      // Supply currents: enforce KCL (sum of all pin currents = 0)
      const iSupplyTotal = -(iInn + iInp + iOut);
      // Vcc+ sources positive current (flows into Vcc+ pin when element draws from it)
      // Vcc- sinks negative current. Split by sign of total supply demand.
      let iVccP: number;
      let iVccN: number;
      if (iSupplyTotal >= 0) {
        // Positive supply provides the current
        iVccP = nVccP > 0 ? iSupplyTotal : 0;
        iVccN = 0;
      } else {
        // Negative supply provides the current
        iVccP = 0;
        iVccN = nVccN > 0 ? iSupplyTotal : 0;
      }

      return [iInn, iInp, iOut, iVccP, iVccN];
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },
  };
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

export const RealOpAmpDefinition: ComponentDefinition = {
  name: "RealOpAmp",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildRealOpAmpPinDeclarations(),
  propertyDefs: REAL_OPAMP_PROPERTY_DEFS,
  attributeMap: REAL_OPAMP_ATTRIBUTE_MAPPINGS,

  helpText:
    "Real Op-Amp — composite model with finite gain, GBW, slew rate, " +
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
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, _branchIdx, props) =>
        createRealOpAmpElement(pinNodes, props),
      paramDefs: REAL_OPAMP_PARAM_DEFS,
      params: REAL_OPAMP_DEFAULTS,
    },
    ...Object.fromEntries(
      Object.entries(REAL_OPAMP_MODELS).map(([name, params]) => [
        name,
        {
          kind: "inline" as const,
          factory: (pinNodes: ReadonlyMap<string, number>, _internalNodeIds: readonly number[], _branchIdx: number, props: PropertyBag) =>
            createRealOpAmpElement(pinNodes, props),
          paramDefs: REAL_OPAMP_PARAM_DEFS,
          params,
        },
      ]),
    ),
  },
  defaultModel: "behavioral",
};
