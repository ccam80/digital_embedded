/**
 * OTA (Operational Transconductance Amplifier) analog component.
 *
 * Voltage-in, current-out amplifier whose transconductance (gm) is
 * controlled by a bias current at the Iabc pin.
 *
 * Transfer function:
 *   gm = min(I_bias / (2 * V_T), gmMax)
 *   I_out = I_bias * tanh(V_diff / (2 * V_T))
 *
 * For small V_diff (|V_diff| << 2*V_T):
 *   tanh(x) ≈ x  →  I_out ≈ gm * V_diff  (linear region)
 *
 * For large V_diff:
 *   I_out → ±I_bias  (saturated at bias current)
 *
 * MNA formulation:
 *   The OTA is a nonlinear VCCS. At operating point V_diff0:
 *     I_out = I_bias * tanh(V_diff0 / (2*V_T))
 *     dI_out/dV_diff = I_bias / (2*V_T) * sech²(V_diff0 / (2*V_T)) = gm_eff
 *
 *   NR-linearized Norton equivalent:
 *     I_out ≈ gm_eff * V_diff + [I_out0 - gm_eff * V_diff0]
 *
 *   Stamped as a VCCS from (V+,V-) controlling current into (OUT+, OUT-):
 *     G[OUT+, V+]  -= gm_eff    G[OUT+, V-]  += gm_eff
 *     G[OUT-, V+]  += gm_eff    G[OUT-, V-]  -= gm_eff
 *     RHS[OUT+]    += I_out0 - gm_eff * V_diff0
 *     RHS[OUT-]    -= I_out0 - gm_eff * V_diff0
 *
 * The bias current node Iabc is read directly from the solution vector.
 * The I_bias value is taken as the net current flowing INTO the Iabc node
 * from an external current source; to model this, we read the node voltage
 * at the Iabc pin and convert it to a current via an external reference
 * conductance. However, per the spec, Iabc is a current INPUT pin — the
 * bias current is directly the current flowing into that node.
 *
 * Implementation note: since we cannot directly read a current at a node
 * without a branch variable, we model Iabc as a voltage node and derive
 * I_bias as V(Iabc) * G_ref, where G_ref is a reference conductance (1 S),
 * yielding I_bias = V(Iabc) numerically (1 A/V). Alternatively, a dedicated
 * external current source stamps the bias current into the Iabc node.
 * In practice users connect a current source to Iabc; the node voltage at
 * Iabc is determined by the external circuit. We read I_bias by summing
 * all currents into the node — but that requires KCL bookkeeping.
 *
 * Simpler and correct approach: model Iabc as a voltage node representing
 * the bias current magnitude, with 1 Ω shunt to ground (so V(Iabc) = I_bias
 * when a current source drives it). This is the standard VCA/OTA test setup.
 * The OTA element reads V(Iabc) directly as I_bias.
 *
 * Pins (nodeIds order):
 *   [0] = nVp   (V+, non-inverting input)
 *   [1] = nVm   (V-, inverting input)
 *   [2] = nIabc (bias current control — voltage here equals I_bias in amps
 *                when the Iabc node is driven by a 1 A/V current source)
 *   [3] = nOutP (OUT+ output)
 *   [4] = nOutN (OUT- output)
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
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOTAPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "V+",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "V-",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "Iabc",
      defaultBitWidth: 1,
      position: { x: 2, y: -3 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT+",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT-",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// OTAAnalogElement
// ---------------------------------------------------------------------------

function createOTAElement(
  nVp: number,
  nVm: number,
  nIabc: number,
  nOutP: number,
  nOutN: number,
  gmMax: number,
  vt: number,
): AnalogElement {
  const twoVt = 2 * vt;

  // Operating-point state
  let vDiff = 0;
  let iBias = 0;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
    nodeIndices: [nVp, nVm, nIabc, nOutP, nOutN],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear topology-constant entries for this nonlinear element.
    },

    stampNonlinear(solver: SparseSolver): void {
      // Evaluate tanh-limited output current at current operating point.
      const x = vDiff / twoVt;
      // tanh computed via standard formula; clamp argument to avoid overflow
      const xClamped = Math.max(-50, Math.min(50, x));
      const tanhX = Math.tanh(xClamped);

      const iOut = iBias * tanhX;

      // Effective transconductance: dI_out/dV_diff = I_bias/(2*V_T) * sech²(x)
      // sech²(x) = 1 - tanh²(x)
      const sech2 = 1 - tanhX * tanhX;
      const gmRaw = (iBias / twoVt) * sech2;
      const gmEff = Math.min(Math.abs(gmRaw), gmMax);

      // NR constant term (Norton offset)
      const iNR = iOut - gmEff * vDiff;

      // Stamp VCCS: current gm_eff * V_diff injected into OUT+ from (V+, V-)
      // G[OUT+, V+] -= gmEff   G[OUT+, V-] += gmEff
      // G[OUT-, V+] += gmEff   G[OUT-, V-] -= gmEff
      if (nOutP !== 0 && nVp !== 0) solver.stamp(nOutP - 1, nVp - 1, -gmEff);
      if (nOutP !== 0 && nVm !== 0) solver.stamp(nOutP - 1, nVm - 1, gmEff);
      if (nOutN !== 0 && nVp !== 0) solver.stamp(nOutN - 1, nVp - 1, gmEff);
      if (nOutN !== 0 && nVm !== 0) solver.stamp(nOutN - 1, nVm - 1, -gmEff);

      // RHS: Norton constant
      if (nOutP !== 0) solver.stampRHS(nOutP - 1, iNR);
      if (nOutN !== 0) solver.stampRHS(nOutN - 1, -iNR);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vp = readNode(voltages, nVp);
      const vm = readNode(voltages, nVm);
      vDiff = vp - vm;

      // I_bias is the voltage at the Iabc node, interpreted as bias current
      // (convention: a current source of value I_bias drives into Iabc with
      // a 1 Ω shunt to ground, so V(Iabc) = I_bias numerically).
      const vIabc = readNode(voltages, nIabc);
      // Bias current must be non-negative (OTA requires positive bias current)
      iBias = Math.max(0, vIabc);
    },
  };
}

// ---------------------------------------------------------------------------
// OTAElement — CircuitElement
// ---------------------------------------------------------------------------

export class OTAElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("OTA", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildOTAPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    const PX = 1 / 16;
    const cr = 19 / 2 * PX;
    const signOverhang = 2 * PX; // sign lines extend 2*PX left of x=0
    return {
      x: this.position.x - signOverhang,
      y: this.position.y - 3,
      width: 3 + 2 * cr + signOverhang,
      height: 5,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const PX = 1 / 16;
    const cr = 19 / 2 * PX;

    const vVp   = signals?.getPinVoltage("V+");
    const vVm   = signals?.getPinVoltage("V-");
    const vIabc = signals?.getPinVoltage("Iabc");
    const vOutP = signals?.getPinVoltage("OUT+");
    const vOutN = signals?.getPinVoltage("OUT-");

    ctx.save();
    ctx.setLineWidth(1);

    // Triangle body — stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [{ x: 0, y: -2 }, { x: 3, y: 0 }, { x: 0, y: 2 }],
      false,
    );

    // Two output circles — body, stays COMPONENT
    ctx.drawCircle(3 + cr, 0, cr, false);
    ctx.drawCircle(3 + cr - (2 * cr - 8 * PX), 0, cr, false);

    // +/- signs — body decoration, stays COMPONENT
    const signX = 4 * PX;
    const signSz = 6 * PX;
    ctx.drawLine(signX - signSz, -1, signX + signSz, -1);
    ctx.drawLine(signX, -1 - signSz, signX, -1 + signSz);
    ctx.drawLine(signX - signSz, 1, signX + signSz, 1);

    // Input lead V+
    if (vVp !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vVp));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, -1, 0.5, -1);

    // Input lead V-
    if (vVm !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vVm));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 1, 0.5, 1);

    // Iabc bias lead
    if (vIabc !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vIabc));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(2, -3, 2, -2);

    // OUT+ stub
    if (vOutP !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vOutP));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(3 + 2 * cr, 0, 4, -1);

    // OUT- stub
    if (vOutN !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vOutN));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(3 + 2 * cr, 0, 4, 1);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Operational Transconductance Amplifier — voltage-in, current-out amplifier. " +
      "I_out = I_bias * tanh(V_diff / (2*V_T)). " +
      "Transconductance gm = I_bias / (2*V_T), up to gmMax. " +
      "Pins: V+, V- (differential input), Iabc (bias current), OUT+, OUT- (output)."
    );
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OTA_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "gmMax",
    type: PropertyType.FLOAT,
    label: "Max transconductance (S)",
    defaultValue: 0.01,
    min: 1e-12,
    description: "Maximum transconductance in siemens. Hard saturation clamp at high bias. Default: 0.01 S.",
  },
  {
    key: "vt",
    type: PropertyType.FLOAT,
    label: "Thermal voltage V_T (V)",
    defaultValue: 0.026,
    min: 1e-6,
    description: "Thermal voltage in volts. Default: 26 mV (room temperature).",
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

const OTA_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "gmMax", propertyKey: "gmMax", convert: (v) => parseFloat(v) },
  { xmlName: "vt",    propertyKey: "vt",    convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// OTADefinition
// ---------------------------------------------------------------------------

export const OTADefinition: ComponentDefinition = {
  name: "OTA",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildOTAPinDeclarations(),
  propertyDefs: OTA_PROPERTY_DEFS,
  attributeMap: OTA_ATTRIBUTE_MAPPINGS,

  helpText:
    "Operational Transconductance Amplifier — 5-terminal element (V+, V-, Iabc, OUT+, OUT-). " +
    "Output current = I_bias * tanh(V_diff / (2*V_T)).",

  factory(props: PropertyBag): OTAElement {
    return new OTAElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    _branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    const gmMax = props.getOrDefault<number>("gmMax", 0.01);
    const vt = props.getOrDefault<number>("vt", 0.026);
    return createOTAElement(
      nodeIds[0], // V+
      nodeIds[1], // V-
      nodeIds[2], // Iabc
      nodeIds[3], // OUT+
      nodeIds[4], // OUT-
      gmMax,
      vt,
    );
  },
};
