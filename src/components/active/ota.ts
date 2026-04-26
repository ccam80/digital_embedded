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
 *   tanh(x) â‰ˆ x  â†’  I_out â‰ˆ gm * V_diff  (linear region)
 *
 * For large V_diff:
 *   I_out â†’ Â±I_bias  (saturated at bias current)
 *
 * MNA formulation:
 *   The OTA is a nonlinear VCCS. At operating point V_diff0:
 *     I_out = I_bias * tanh(V_diff0 / (2*V_T))
 *     dI_out/dV_diff = I_bias / (2*V_T) * sechÂ²(V_diff0 / (2*V_T)) = gm_eff
 *
 *   NR-linearized Norton equivalent:
 *     I_out â‰ˆ gm_eff * V_diff + [I_out0 - gm_eff * V_diff0]
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
 * conductance. However, per the spec, Iabc is a current INPUT pin â€” the
 * bias current is directly the current flowing into that node.
 *
 * Implementation note: since we cannot directly read a current at a node
 * without a branch variable, we model Iabc as a voltage node and derive
 * I_bias as V(Iabc) * G_ref, where G_ref is a reference conductance (1 S),
 * yielding I_bias = V(Iabc) numerically (1 A/V). Alternatively, a dedicated
 * external current source stamps the bias current into the Iabc node.
 * In practice users connect a current source to Iabc; the node voltage at
 * Iabc is determined by the external circuit. We read I_bias by summing
 * all currents into the node â€” but that requires KCL bookkeeping.
 *
 * Simpler and correct approach: model Iabc as a voltage node representing
 * the bias current magnitude, with 1 Î© shunt to ground (so V(Iabc) = I_bias
 * when a current source drives it). This is the standard VCA/OTA test setup.
 * The OTA element reads V(Iabc) directly as I_bias.
 *
 * Pins (nodeIds order):
 *   [0] = nVp   (V+, non-inverting input)
 *   [1] = nVm   (V-, inverting input)
 *   [2] = nIabc (bias current control â€” voltage here equals I_bias in amps
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
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: OTA_PARAM_DEFS, defaults: OTA_DEFAULTS } = defineModelParams({
  primary: {
    gmMax: { default: 0.01, unit: "S", description: "Maximum transconductance" },
    vt:    { default: 0.026, unit: "V", description: "Thermal voltage V_T" },
  },
});

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
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "V-",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "Iabc",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT+",
      defaultBitWidth: 1,
      position: { x: 4.875, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT",
      defaultBitWidth: 1,
      position: { x: 5.875, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// OTAAnalogElement
// ---------------------------------------------------------------------------

function createOTAElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const p: Record<string, number> = {
    gmMax: props.getModelParam<number>("gmMax"),
    vt:    props.getModelParam<number>("vt"),
  };

  const nVp   = pinNodes.get("V+")!;
  const nVm   = pinNodes.get("V-")!;
  const nIabc = pinNodes.get("Iabc")!;
  const nOutP = pinNodes.get("OUT+")!;
  const nOutN = pinNodes.get("OUT")!;

  // Operating-point state
  let vDiff = 0;
  let iBias = 0;
  let iOut = 0; // cached output current for getPinCurrents

  function readNode(voltages: Float64Array, n: number): number {
    return voltages[n];
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.rhsOld;
      const twoVt = 2 * p.vt;

      // Read operating-point voltages
      const vp = readNode(voltages, nVp);
      const vm = readNode(voltages, nVm);
      vDiff = vp - vm;
      const vIabc = readNode(voltages, nIabc);
      // Bias current must be non-negative (OTA requires positive bias current)
      iBias = Math.max(0, vIabc);

      // Evaluate tanh-limited output current at current operating point.
      const x = vDiff / twoVt;
      const xClamped = Math.max(-50, Math.min(50, x));
      const tanhX = Math.tanh(xClamped);
      const iOutNow = iBias * tanhX;
      iOut = iOutNow;

      // Effective transconductance: dI_out/dV_diff = I_bias/(2*V_T) * sechÂ²(x)
      // sechÂ²(x) = 1 - tanhÂ²(x)
      const sech2 = 1 - tanhX * tanhX;
      const gmRaw = (iBias / twoVt) * sech2;
      const gmEff = Math.min(Math.abs(gmRaw), p.gmMax);

      // NR constant term (Norton offset)
      const iNR = iOutNow - gmEff * vDiff;

      // Stamp VCCS: current gm_eff * V_diff injected into OUT+ from (V+, V-)
      if (nOutP !== 0 && nVp !== 0) solver.stampElement(solver.allocElement(nOutP, nVp), -gmEff);
      if (nOutP !== 0 && nVm !== 0) solver.stampElement(solver.allocElement(nOutP, nVm), gmEff);
      if (nOutN !== 0 && nVp !== 0) solver.stampElement(solver.allocElement(nOutN, nVp), gmEff);
      if (nOutN !== 0 && nVm !== 0) solver.stampElement(solver.allocElement(nOutN, nVm), -gmEff);

      // RHS: Norton constant
      if (nOutP !== 0) solver.stampRHS(nOutP, iNR);
      if (nOutN !== 0) solver.stampRHS(nOutN, -iNR);
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

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// OTAElement â€” CircuitElement
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
    // Rightmost extent: OUT pin at x=5.875 + circle radius 0.55125 â‰ˆ 6.42625
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

    // Triangle body â€” open polyline (not closed polygon)
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
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("+", 0.5625, -2.125, { horizontal: "center", vertical: "middle" });
    ctx.drawText("-", 0.5625, 2.0, { horizontal: "center", vertical: "middle" });

    // Pin labels
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("Iabc", 0.2, 0, { horizontal: "left", vertical: "bottom" });
    ctx.drawText("OUT+", 4.875, -1.6, { horizontal: "center", vertical: "bottom" });
    ctx.drawText("OUT", 5.875, -0.4, { horizontal: "center", vertical: "bottom" });

    ctx.restore();
    void vVp; void vVm; void vIabc; void vOutP; void vOut;
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OTA_PROPERTY_DEFS: PropertyDefinition[] = [
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
  { xmlName: "gmMax", propertyKey: "gmMax", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vt",    propertyKey: "vt",    convert: (v) => parseFloat(v), modelParam: true },
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
    "Operational Transconductance Amplifier â€” 5-terminal element (V+, V-, Iabc, OUT+, OUT). " +
    "Output current = I_bias * tanh(V_diff / (2*V_T)).",

  factory(props: PropertyBag): OTAElement {
    return new OTAElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createOTAElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: OTA_PARAM_DEFS,
      params: OTA_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
