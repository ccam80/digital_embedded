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
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
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
import type { AnalogElement, IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

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
    vos: 1e-3,
    iBias: 80e-9,
    rIn: 2e6,
    rOut: 75,
    iMax: 25e-3,
    vSatPos: 1.5,
    vSatNeg: 1.5,
  },
  "LM358": {
    aol: 100000,
    gbw: 1e6,
    slewRate: 0.3e6,
    vos: 2e-3,
    iBias: 45e-9,
    rIn: 2e6,
    rOut: 75,
    iMax: 20e-3,
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
    iMax: 30e-3,
    vSatPos: 1.5,
    vSatNeg: 1.5,
  },
  "OPA2134": {
    aol: 1e6,
    gbw: 8e6,
    slewRate: 20e6,
    vos: 25e-6,
    iBias: 5e-12,
    rIn: 1e13,
    rOut: 40,
    iMax: 35e-3,
    vSatPos: 1.0,
    vSatNeg: 1.0,
  },
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
    },
    {
      direction: PinDirection.INPUT,
      label: "in+",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "Vcc+",
      defaultBitWidth: 1,
      position: { x: 2, y: -2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "Vcc-",
      defaultBitWidth: 1,
      position: { x: 2, y: 2 },
      isNegatable: false,
      isClockCapable: false,
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
    const PX = 1 / 16;

    const vInp  = signals?.getPinVoltage("in+");
    const vInn  = signals?.getPinVoltage("in-");
    const vOut  = signals?.getPinVoltage("out");
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
    if (vVccP !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vVccP));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(2, -2, 2, -1);

    // Supply rail stubs: Vcc- stub
    if (vVccN !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vVccN));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(2, 2, 2, 1);

    // +/- signs — body decoration, stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.drawText('-', 13 / 16, -18 / 16, { horizontal: "center", vertical: "middle" });
    ctx.drawText('+', 13 / 16, 16 / 16, { horizontal: "center", vertical: "middle" });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Real Op-Amp — finite gain, GBW, slew rate, input offset, bias currents, " +
      "output resistance, current limiting, and rail saturation."
    );
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
 *   - R_in conductance between in+ and in- (always linear, stamped in stamp())
 *   - Bias current sources I_bias stamped in stampNonlinear()
 *
 * Gain stage (DC: same as ideal op-amp VCVS; transient: companion integrator):
 *
 *   In the unsaturated, non-current-limited region the gain stage provides:
 *     V_out = A_eff * (V_diff + V_os)
 *   where A_eff = aol in DC, and is modified by the companion integrator in transient.
 *
 *   The NR linearization at operating point (Vinp0, Vinn0, Vout0):
 *     MNA row for out:
 *       G[out,out] += G_out                   (stamped in stamp())
 *       G[out,in+] -= A_eff * G_out           (Jacobian: stampNonlinear)
 *       G[out,in-] += A_eff * G_out           (Jacobian: stampNonlinear)
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
 * Transient (stampCompanion active):
 *   A_eff is reduced by the companion integrator's bandwidth-limiting factor.
 *   The effective gain at frequency ω is A_OL / (1 + jω*τ), implemented as
 *   a first-order BDF-1 update of V_int each timestep with slew-rate clamping.
 */
export function createRealOpAmpElement(
  nodeIds: number[],
  props: PropertyBag,
): AnalogElement {
  // Extract parameters with defaults
  let aol       = Math.max(props.getOrDefault<number>("aol",       100000),  1);
  let gbw       = Math.max(props.getOrDefault<number>("gbw",       1e6),     1);
  let slewRate  = Math.max(props.getOrDefault<number>("slewRate",  0.5e6),   1e-6);
  let vos       = props.getOrDefault<number>("vos",       0);
  let iBias     = Math.abs(props.getOrDefault<number>("iBias",     0));
  const rIn     = Math.max(props.getOrDefault<number>("rIn",       2e6),     1e-9);
  const rOut    = Math.max(props.getOrDefault<number>("rOut",      75),      1e-9);
  const iMax    = Math.max(props.getOrDefault<number>("iMax",      25e-3),   1e-12);
  const vSatPos = Math.max(props.getOrDefault<number>("vSatPos",   1.5),     0);
  const vSatNeg = Math.max(props.getOrDefault<number>("vSatNeg",   1.5),     0);

  // Apply named model overrides if specified
  const modelName = props.getOrDefault<string>("model", "");
  if (modelName.length > 0) {
    const preset = REAL_OPAMP_MODELS[modelName];
    if (preset) {
      aol      = preset.aol;
      gbw      = preset.gbw;
      slewRate = preset.slewRate;
      vos      = preset.vos;
      iBias    = preset.iBias;
    }
  }

  const G_out = 1 / rOut;
  const G_in  = 1 / rIn;

  // Single-pole rolloff time constant: τ = A_OL / (2π * GBW)
  const tau = aol / (2 * Math.PI * gbw);

  const nInp  = nodeIds[0]; // in+
  const nInn  = nodeIds[1]; // in-
  const nOut  = nodeIds[2]; // out
  const nVccP = nodeIds[3]; // Vcc+
  const nVccN = nodeIds[4]; // Vcc-

  // Internal gain-stage state — not an MNA node.
  // Updated each NR iteration in updateOperatingPoint.
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
  let vOutPrev = 0;      // output voltage at previous accepted timestep

  // Source scale for source-stepping DC convergence
  let scale = 1;

  // Transient: effective gain reduced from A_OL by bandwidth limiting.
  // In DC mode (no companion): aEff = aol. In transient: aEff < aol.
  let aEff = aol;

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
    if (nA > 0) solver.stamp(nA - 1, nA - 1, g);
    if (nB > 0) solver.stamp(nB - 1, nB - 1, g);
    if (nA > 0 && nB > 0) {
      solver.stamp(nA - 1, nB - 1, -g);
      solver.stamp(nB - 1, nA - 1, -g);
    }
  }

  return {
    nodeIndices: [nInp, nInn, nOut, nVccP, nVccN],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    setSourceScale(factor: number): void {
      scale = factor;
    },

    stamp(solver: SparseSolver): void {
      // Input resistance between in+ and in- (always present)
      stampCond(solver, nInp, nInn, G_in);

      // Output conductance G_out (always present for NR stability)
      if (nOut > 0) {
        solver.stamp(nOut - 1, nOut - 1, G_out);
      }
    },

    stampCompanion(
      dt: number,
      _method: IntegrationMethod,
      voltages: Float64Array,
    ): void {
      // Record the previous accepted-timestep vInt and output voltage, and set
      // up the companion conductance geq_int = tau/dt for the gain-stage integrator.
      vIntPrev = vInt;
      vOutPrev = readNode(voltages, nOut);
      geq_int  = tau / dt;
    },

    stampNonlinear(solver: SparseSolver): void {
      // 1. Input bias currents
      const iBiasScaled = iBias * scale;
      if (nInp > 0) solver.stampRHS(nInp - 1, -iBiasScaled);
      if (nInn > 0) solver.stampRHS(nInn - 1, -iBiasScaled);

      if (nOut <= 0) return;

      // 2. Gain-stage output
      //
      // DC/small-signal unsaturated case:
      //   V_out ≈ A_eff * (V_diff + V_os)
      //   Linearizing around (vInp, vInn):
      //     f(V_diff) = A_eff * V_diff + A_eff * V_os
      //     f'(V_diff) = A_eff
      //   NR MNA (Norton form):
      //     G[out, in+] -= A_eff * G_out    (Jacobian: output depends on in+)
      //     G[out, in-] += A_eff * G_out    (Jacobian: output depends on in-)
      //     RHS[out]    += G_out * A_eff * V_os   (constant bias offset)
      //
      //   This is identical to the ideal op-amp stamp. The V_os offset shifts
      //   the virtual-ground equilibrium by V_os.
      //
      // Saturated case: same as ideal op-amp — drive output to clamp level.
      //
      // Slewing case (transient only): output tracks vInt directly.

      if (outputSaturated) {
        // Output clamped to rail — no input coupling
        solver.stampRHS(nOut - 1, outputClampLevel * G_out);

      } else if (currentLimited) {
        // Output current limited — inject ±I_max as a Norton current source.
        // G_out is already stamped by stamp(); RHS carries only the current source.
        solver.stampRHS(nOut - 1, iOutLimited);

      } else if (slewLimited) {
        // Slewing: output tracks vInt directly with no Jacobian coupling to inputs.
        // The output is driven toward vInt by the Norton current source.
        solver.stampRHS(nOut - 1, vInt * G_out);

      } else {
        // Normal operation: bandwidth-limited VCVS with BDF-1 history current.
        //
        // The gain-stage BDF-1 companion gives:
        //   vInt = aEff * vDiff + ieq/G_out
        // where:
        //   aEff = aol / (1 + geq_int)   (bandwidth-limited gain)
        //   ieq  = (geq_int / (1 + geq_int)) * vIntPrev * G_out  (history current)
        //
        // In DC mode geq_int = 0, so aEff = aol and ieq = 0 (pure VCVS).
        // In transient mode the history current carries forward the previous
        // accepted vIntPrev, making the NR equation linear and convergent in
        // one iteration regardless of the initial iterate.
        const aEffScaled = aEff * scale;
        const ieq = geq_int > 0
          ? (geq_int / (1 + geq_int)) * vIntPrev * G_out
          : 0;
        if (nInp > 0) solver.stamp(nOut - 1, nInp - 1, -aEffScaled * G_out);
        if (nInn > 0) solver.stamp(nOut - 1, nInn - 1,  aEffScaled * G_out);
        // History current + V_os offset
        solver.stampRHS(nOut - 1, ieq + aEffScaled * G_out * vos * scale);
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      vInp  = readNode(voltages, nInp);
      vInn  = readNode(voltages, nInn);
      vVccP = readNode(voltages, nVccP);
      vVccN = readNode(voltages, nVccN);
      vOut  = readNode(voltages, nOut);

      const vDiff = vInp - vInn;
      const vOsScaled = vos * scale;

      // Supply rail limits
      const vRailPos = vVccP - vSatPos;
      const vRailNeg = vVccN + vSatNeg;

      if (geq_int > 0) {
        // Transient: re-evaluate slew state from current NR-iterate voltages.
        // With the BDF-1 history current in stampNonlinear, normal-mode NR is
        // linear and converges in one iteration regardless of the starting point,
        // so re-evaluating slewLimited/aEff on every call is safe — there is no
        // oscillation risk as long as the stamp and the operating-point update
        // agree on the slew state.
        const g = geq_int;
        const dt = tau / g;
        const slewLimit = slewRate * dt;
        const target = (aol * (vDiff + vOsScaled) + g * vIntPrev) / (1 + g);
        const delta = target - vIntPrev;
        const clampedDelta = Math.max(-slewLimit, Math.min(slewLimit, delta));
        slewLimited = Math.abs(delta) > slewLimit;
        vInt = vIntPrev + clampedDelta;
        aEff = slewLimited ? 0 : aol / (1 + g);

        // Rail clamp on freshly computed vInt
        if (vVccP > vVccN) {
          vInt = Math.max(vRailNeg, Math.min(vRailPos, vInt));
        } else {
          vInt = Math.max(-1000, Math.min(1000, vInt));
        }
      } else {
        // DC: V_int tracks A_OL*(V_diff + V_os) directly
        vInt = aol * (vDiff + vOsScaled);
        aEff = aol;
        slewLimited = false;

        // Rail clamp
        if (vVccP > vVccN) {
          vInt = Math.max(vRailNeg, Math.min(vRailPos, vInt));
        } else {
          vInt = Math.max(-1000, Math.min(1000, vInt));
        }
      }

      // Determine output saturation from output node voltage
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

      // Output current limiting: only meaningful when the output is saturated.
      // In linear (non-saturated) operation the closed-loop feedback sets V_out,
      // so the Norton current (vInt - vOut)*G_out is not the actual load current.
      // Applying current limiting in the linear region causes NR oscillation
      // because vInt is the huge unclamped open-loop voltage during iteration.
      // When saturated, vInt is rail-clamped and (vInt - vOut)*G_out correctly
      // represents the drive current into the load.
      if (outputSaturated) {
        const iOut = (outputClampLevel - vOut) * G_out;
        if (Math.abs(iOut) > iMax) {
          currentLimited = true;
          iOutLimited    = iOut > 0 ? iMax : -iMax;
        } else {
          currentLimited = false;
          iOutLimited    = 0;
        }
      } else {
        currentLimited = false;
        iOutLimited    = 0;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const REAL_OPAMP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "model",
    type: PropertyType.STRING,
    label: "Model",
    defaultValue: "",
    description:
      "Named op-amp model (741, LM358, TL072, OPA2134). When set, overrides aol/gbw/slewRate/vos/iBias.",
  },
  {
    key: "aol",
    type: PropertyType.INT,
    label: "Open-loop gain",
    defaultValue: 100000,
    min: 1,
    description: "Open-loop DC voltage gain (dimensionless). Default 100000 = 100dB.",
  },
  {
    key: "gbw",
    type: PropertyType.INT,
    label: "Gain-bandwidth product (Hz)",
    defaultValue: 1e6,
    min: 1,
    description: "Gain-bandwidth product in Hz. Sets the -3dB bandwidth = GBW/A_OL. Default 1 MHz.",
  },
  {
    key: "slewRate",
    type: PropertyType.INT,
    label: "Slew rate (V/s)",
    defaultValue: 0.5e6,
    min: 1e-6,
    description: "Maximum output voltage rate of change in V/s. Default 0.5 V/µs.",
  },
  {
    key: "vos",
    type: PropertyType.INT,
    label: "Input offset voltage (V)",
    defaultValue: 1e-3,
    description: "Input offset voltage in volts. Default 1 mV.",
  },
  {
    key: "iBias",
    type: PropertyType.INT,
    label: "Input bias current (A)",
    defaultValue: 80e-9,
    min: 0,
    description: "Input bias current magnitude in amperes. Default 80 nA.",
  },
  {
    key: "rIn",
    type: PropertyType.INT,
    label: "Input resistance (Ω)",
    defaultValue: 2e6,
    min: 1e-9,
    description: "Differential input resistance in ohms. Default 2 MΩ (bipolar). Use 1e12 for FET-input.",
  },
  {
    key: "rOut",
    type: PropertyType.INT,
    label: "Output resistance (Ω)",
    defaultValue: 75,
    min: 1e-9,
    description: "Output resistance in ohms. Default 75 Ω.",
  },
  {
    key: "iMax",
    type: PropertyType.INT,
    label: "Output current limit (A)",
    defaultValue: 25e-3,
    min: 1e-12,
    description: "Maximum output current magnitude in amperes. Default 25 mA.",
  },
  {
    key: "vSatPos",
    type: PropertyType.INT,
    label: "Positive rail saturation drop (V)",
    defaultValue: 1.5,
    min: 0,
    description:
      "Positive output saturation drop from Vcc+: V_out_max = Vcc+ - vSatPos. Default 1.5 V.",
  },
  {
    key: "vSatNeg",
    type: PropertyType.INT,
    label: "Negative rail saturation drop (V)",
    defaultValue: 1.5,
    min: 0,
    description:
      "Negative output saturation drop from Vcc-: V_out_min = Vcc- + vSatNeg. Default 1.5 V.",
  },
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
  { xmlName: "aol",      propertyKey: "aol",      convert: (v) => parseFloat(v) },
  { xmlName: "gbw",      propertyKey: "gbw",      convert: (v) => parseFloat(v) },
  { xmlName: "slewRate", propertyKey: "slewRate", convert: (v) => parseFloat(v) },
  { xmlName: "vos",      propertyKey: "vos",      convert: (v) => parseFloat(v) },
  { xmlName: "iBias",    propertyKey: "iBias",    convert: (v) => parseFloat(v) },
  { xmlName: "rIn",      propertyKey: "rIn",      convert: (v) => parseFloat(v) },
  { xmlName: "rOut",     propertyKey: "rOut",     convert: (v) => parseFloat(v) },
  { xmlName: "iMax",     propertyKey: "iMax",     convert: (v) => parseFloat(v) },
  { xmlName: "vSatPos",  propertyKey: "vSatPos",  convert: (v) => parseFloat(v) },
  { xmlName: "vSatNeg",  propertyKey: "vSatNeg",  convert: (v) => parseFloat(v) },
  { xmlName: "Label",    propertyKey: "label",    convert: (v) => v },
];

// ---------------------------------------------------------------------------
// RealOpAmpDefinition
// ---------------------------------------------------------------------------

export const RealOpAmpDefinition: ComponentDefinition = {
  name: "RealOpAmp",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

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

  analogFactory(
    nodeIds: number[],
    _branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    return createRealOpAmpElement(nodeIds, props);
  },
};
