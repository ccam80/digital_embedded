/**
 * Ideal Op-Amp analog component.
 *
 * Three-terminal nonlinear element: in+ (non-inverting), in- (inverting),
 * out (output). Supply rails are fixed at +15 V and -15 V.
 *
 * MNA Norton approximation:
 *   - Output conductance G_out = 1/R_out stamped from out node to ground.
 *   - VCVS modelled as a controlled current source: I = A * (V_inp - V_inn) * G_out
 *   - Jacobian entries: J[out, inp] += A * G_out, J[out, inn] -= A * G_out
 *   - Saturation clamp: when A*(V_inp - V_inn) exceeds [Vcc-, Vcc+], output
 *     is clamped to the rail voltage and Jacobian entries are zeroed.
 *
 * The op-amp is nonlinear because of the saturation clamp. In the linear
 * region, the Norton stamp is equivalent to an ideal VCVS with gain A and
 * output impedance R_out.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect, TextAnchor } from "../../core/renderer-interface.js";
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
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOpAmpPinDeclarations(): PinDeclaration[] {
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
  ];
}

// ---------------------------------------------------------------------------
// OpAmpElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class OpAmpElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("OpAmp", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildOpAmpPinDeclarations(), []);
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
    const vInp = signals?.getPinVoltage("in+");
    const vInn = signals?.getPinVoltage("in-");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    // Triangle body — stays COMPONENT color
    // Matches Falstad 3-point polyline (6,-32)→(6,32)→(58,0) which draws only 2 segments
    ctx.setColor("COMPONENT");
    ctx.drawLine(0.375, -2, 0.375, 2);
    ctx.drawLine(0.375, 2, 3.625, 0);

    // +/- labels inside triangle body
    ctx.setColor("COMPONENT");
    ctx.drawText("-", 1.0, -1.125, { horizontal: "center", vertical: "middle" });
    ctx.drawText("+", 1.0, 1.0, { horizontal: "center", vertical: "middle" });

    // Input lead in+ colored by its pin voltage (in+ is at y:1)
    drawColoredLead(ctx, signals, vInp, 0, 1, 0.375, 1);

    // Input lead in- colored by its pin voltage (in- is at y:-1)
    drawColoredLead(ctx, signals, vInn, 0, -1, 0.375, -1);

    // Output lead colored by its pin voltage
    drawColoredLead(ctx, signals, vOut, 3.625, 0, 4, 0);

    ctx.restore();
  }

}


// ---------------------------------------------------------------------------
// createOpAmpElement — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for an ideal op-amp.
 *
 * Pin nodes (from pinLayout order: in-, in+, out):
 *   pinNodes.get("in-") = inverting input node (1-based, 0=ground)
 *   pinNodes.get("in+") = non-inverting input node
 *   pinNodes.get("out") = output node
 *
 * Supply rails are fixed constants: +15 V and -15 V.
 *
 * The output is modelled as a Norton equivalent:
 *   - Conductance G_out = 1/R_out between out and ground
 *   - Current source I = clamp(A*(V+ - V-), Vcc-, Vcc+) * G_out injected at out
 *   - Jacobian uses a capped gain for NR stability; the RHS uses the full gain
 *
 * Solver indices are 0-based (nodeId - 1 for non-ground nodes).
 */
function createOpAmpElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const gain = props.getOrDefault<number>("gain", 1e6);
  const rOut = Math.max(props.getOrDefault<number>("rOut", 75), 1e-9);
  const G_out = 1 / rOut;

  const nInp = pinNodes.get("in+")!; // non-inverting input node (1-based, 0=ground)
  const nInn = pinNodes.get("in-")!; // inverting input node
  const nOut = pinNodes.get("out")!; // output node
  // Operating-point state updated by updateOperatingPoint
  let vInp = 0;
  let vInn = 0;
  let vVccP = 15;  // default rail +15V
  let vVccN = -15; // default rail -15V
  let saturated = false;
  let vOutTarget = 0; // clamped target output voltage

  // Source-stepping scale: ramped from 0 to 1 by the DC OP solver.
  // At scale=0 the effective gain is 0 (trivial circuit); at scale=1 full gain.
  let scale = 1;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    setSourceScale(factor: number): void {
      scale = factor;
    },

    stamp(solver: SparseSolver): void {
      // G_out: output resistance between nOut and ground (always present).
      if (nOut > 0) {
        solver.stamp(nOut - 1, nOut - 1, G_out);
      }

      // Linear VCVS stamp in unsaturated region.
      // Implements: (V_out - gain*(V_inp - V_inn)) / R_out = 0
      // which rearranges to: G_out*V_out - gain*G_out*V_inp + gain*G_out*V_inn = 0
      // MNA row for out: G[out,out] += G_out (above), G[out,in+] -= gain*G_out,
      //                                                G[out,in-] += gain*G_out
      if (!saturated) {
        const effectiveGain = gain * scale;
        if (nOut > 0 && nInp > 0) {
          solver.stamp(nOut - 1, nInp - 1, -effectiveGain * G_out);
        }
        if (nOut > 0 && nInn > 0) {
          solver.stamp(nOut - 1, nInn - 1, effectiveGain * G_out);
        }
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // Saturation: inject Norton current to clamp output to rail voltage.
      // In linear region: no nonlinear contribution (all handled in stamp()).
      if (saturated && nOut > 0) {
        solver.stampRHS(nOut - 1, vOutTarget * G_out);
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      vInp = readNode(voltages, nInp);
      vInn = readNode(voltages, nInn);

      // Saturation is determined by the current output voltage, not the ideal
      // open-loop voltage. This prevents oscillation: the linear stamp is used
      // whenever the output is within the supply rails, letting NR find the
      // virtual-ground solution (V_inn ≈ 0) without toggling the Jacobian.
      const vOut = readNode(voltages, nOut);

      if (vOut >= vVccP) {
        saturated = true;
        vOutTarget = vVccP;
      } else if (vOut <= vVccN) {
        saturated = true;
        vOutTarget = vVccN;
      } else {
        saturated = false;
        vOutTarget = vOut;
      }
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Input pins: ideal op-amp — infinite input impedance, zero input current.
      // No conductance is stamped at in+ or in- nodes, so I_in+ = I_in- = 0.

      // Output pin: Norton equivalent — conductance G_out from nOut to ground.
      //   Linear region:   vOutTarget = gain*(V_inp - V_inn)  (full open-loop target)
      //   Saturated region: vOutTarget = rail voltage
      // The element sources (vOutTarget - V_out)*G_out into the nOut node.
      // Current INTO element at out = (V_out - vOutTarget) * G_out.
      const vOut = readNode(voltages, nOut);
      // In linear region vOutTarget was set to vOut (current operating point),
      // but we need the ideal target to compute the current correctly.
      // Reconstruct: in linear, target = gain * scale * (V_inp - V_inn).
      const idealTarget = saturated
        ? vOutTarget
        : gain * scale * (vInp - vInn);
      const iOut = nOut > 0 ? (vOut - idealTarget) * G_out : 0;

      // pinLayout order: in-, in+, out
      // Sum is nonzero — residual is implicit supply current (no explicit Vcc/Vee pins).
      return [0, 0, iOut];
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OPAMP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "gain",
    type: PropertyType.INT,
    label: "Open-loop gain",
    defaultValue: 1e6,
    min: 1,
    description: "Open-loop voltage gain A (dimensionless). Default 1e6.",
  },
  {
    key: "rOut",
    type: PropertyType.INT,
    label: "Output impedance (Ω)",
    defaultValue: 75,
    min: 1e-9,
    description: "Output resistance in ohms. Default 75 Ω.",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const OPAMP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "gain",  propertyKey: "gain",  convert: (v) => parseFloat(v) },
  { xmlName: "rOut",  propertyKey: "rOut",  convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// OpAmpDefinition
// ---------------------------------------------------------------------------

export const OpAmpDefinition: ComponentDefinition = {
  name: "OpAmp",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildOpAmpPinDeclarations(),
  propertyDefs: OPAMP_PROPERTY_DEFS,
  attributeMap: OPAMP_ATTRIBUTE_MAPPINGS,

  helpText:
    "Ideal Op-Amp — 3-terminal nonlinear element (in+, in-, out). " +
    "High-gain voltage amplifier with output saturation at supply rails.",

  factory(props: PropertyBag): OpAmpElement {
    return new OpAmpElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {
    mnaModels: {
      behavioral: {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        internalNodeIds: readonly number[],
        branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        return createOpAmpElement(pinNodes, internalNodeIds, branchIdx, props);
      },
    },
    },
  },
  defaultModel: "behavioral",
};
