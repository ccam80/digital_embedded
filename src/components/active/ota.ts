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
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOTAPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "V+",
      defaultBitWidth: 1,
      position: { x: 0, y: -2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "V-",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "Iabc",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT+",
      defaultBitWidth: 1,
      position: { x: 4.875, y: -2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT",
      defaultBitWidth: 1,
      position: { x: 5.875, y: 0 },
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
): AnalogElementCore {
  const twoVt = 2 * vt;

  // Operating-point state
  let vDiff = 0;
  let iBias = 0;
  let iOut = 0; // cached output current for getPinCurrents

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
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

      // Cache output current for getPinCurrents
      const x = vDiff / twoVt;
      const xClamped = Math.max(-50, Math.min(50, x));
      iOut = iBias * Math.tanh(xClamped);
    },

    /**
     * Per-pin currents in pinLayout order: [V+, V-, Iabc, OUT+, OUT].
     *
     * V+, V-, Iabc are high-impedance inputs that draw no current from the
     * OTA element itself. The output current iOut flows INTO OUT+ and OUT OF
     * OUT (OUT-), satisfying KCL: 0 + 0 + 0 + iOut + (-iOut) = 0.
     *
     * Positive value = current flowing INTO the element at that pin.
     */
    getPinCurrents(_voltages: Float64Array): number[] {
      return [0, 0, 0, iOut, -iOut];
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
    // Leftmost extent: arrow triangles extend to x=-0.25
    // Rightmost extent: OUT pin at x=5.875 + circle radius 0.55125 ≈ 6.42625
    // Top: y=-3 (triangle apex at V+ lead), Bottom: y=3 (triangle apex at V- lead)
    return {
      x: this.position.x - 0.25,
      y: this.position.y - 3,
      width: 5.875 + 0.55125 + 0.25,
      height: 6,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vVp   = signals?.getPinVoltage("V+");
    const vVm   = signals?.getPinVoltage("V-");
    const vIabc = signals?.getPinVoltage("Iabc");
    const vOutP = signals?.getPinVoltage("OUT+");
    const vOut  = signals?.getPinVoltage("OUT");

    ctx.save();
    ctx.setLineWidth(1);
    ctx.setColor("COMPONENT");

    // Triangle body — open polyline (not closed polygon)
    ctx.drawPolygon(
      [{ x: 0, y: -3 }, { x: 0, y: 3 }, { x: 4, y: 0 }],
      false,
    );

    // + arrow (filled triangle pointing up-right)
    ctx.drawPolygon([
      { x: 0, y: -1.3125 },
      { x: -0.25, y: -0.8125 },
      { x: 0.25, y: -0.8125 },
    ], true);

    // - arrow (filled triangle pointing down-right)
    ctx.drawPolygon([
      { x: 0, y: 1.3125 },
      { x: 0.25, y: 0.8125 },
      { x: -0.25, y: 0.8125 },
    ], true);

    // Horizontal bar for + sign
    ctx.drawLine(-0.25, -1.3125, 0.25, -1.3125);

    // Horizontal bar for - sign
    ctx.drawLine(0.25, 1.3125, -0.25, 1.3125);

    // OUT+ pin lead: connects OUT+ pin at (4.875, -2) down to output circles area
    ctx.drawLine(4.875, -2, 4.875, -0.5);

    // Two output buffer circles
    ctx.drawCircle(5.25, 0, 0.55125, false);
    ctx.drawCircle(4.5625, 0, 0.55125, false);

    // Text labels
    ctx.drawText("+", 0.5625, -2.125, { horizontal: "center", vertical: "middle" });
    ctx.drawText("-", 0.5625, 2.0, { horizontal: "center", vertical: "middle" });

    ctx.restore();
    void vVp; void vVm; void vIabc; void vOutP; void vOut;
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
  category: ComponentCategory.ACTIVE,

  pinLayout: buildOTAPinDeclarations(),
  propertyDefs: OTA_PROPERTY_DEFS,
  attributeMap: OTA_ATTRIBUTE_MAPPINGS,

  helpText:
    "Operational Transconductance Amplifier — 5-terminal element (V+, V-, Iabc, OUT+, OUT). " +
    "Output current = I_bias * tanh(V_diff / (2*V_T)).",

  factory(props: PropertyBag): OTAElement {
    return new OTAElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {
    analog: {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        _branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        const gmMax = props.getOrDefault<number>("gmMax", 0.01);
        const vt = props.getOrDefault<number>("vt", 0.026);
        return createOTAElement(
          pinNodes.get("V+")!,   // V+
          pinNodes.get("V-")!,   // V-
          pinNodes.get("Iabc")!, // Iabc
          pinNodes.get("OUT+")!, // OUT+
          pinNodes.get("OUT")!,  // OUT (OUT-)
          gmMax,
          vt,
        );
      },
    },
  },
};
