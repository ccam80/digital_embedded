/**
 * Ideal Op-Amp analog component.
 *
 * Five-terminal nonlinear element: in+ (non-inverting), in- (inverting),
 * out (output), Vcc+ (positive supply), Vcc- (negative supply).
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
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
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

function buildOpAmpPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in+",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "in-",
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

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Triangle body: pointing right
    // Vertices: (0, -2), (0, 2), (4, 0)
    ctx.drawLine(0, -2, 0, 2);
    ctx.drawLine(0, -2, 4, 0);
    ctx.drawLine(0, 2, 4, 0);

    // + label at non-inverting input (top-left)
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("+", 0.5, -1, { horizontal: "left", vertical: "center" });

    // - label at inverting input (bottom-left)
    ctx.drawText("−", 0.5, 1, { horizontal: "left", vertical: "center" });

    // Optional label above
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 2, -2.3, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Ideal Op-Amp — 5-terminal nonlinear element with high gain, output saturation " +
      "at supply rails, and configurable output impedance."
    );
  }
}


// ---------------------------------------------------------------------------
// createOpAmpElement — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for an ideal op-amp.
 *
 * Node assignment (1-based, 0 = ground):
 *   nodeIds[0] = in+ (non-inverting input)
 *   nodeIds[1] = in- (inverting input)
 *   nodeIds[2] = out (output)
 *   nodeIds[3] = Vcc+ (positive supply)
 *   nodeIds[4] = Vcc- (negative supply)
 *
 * The output is modelled as a Norton equivalent:
 *   - Conductance G_out = 1/R_out between out and ground
 *   - Current source I = clamp(A*(V+ - V-), Vcc-, Vcc+) * G_out injected at out
 *   - Jacobian uses a capped gain for NR stability; the RHS uses the full gain
 *
 * Solver indices are 0-based (nodeId - 1 for non-ground nodes).
 */
function createOpAmpElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const gain = props.getOrDefault<number>("gain", 1e6);
  const rOut = Math.max(props.getOrDefault<number>("rOut", 75), 1e-9);
  const G_out = 1 / rOut;

  const nInp = nodeIds[0]; // in+ node (1-based, 0=ground)
  const nInn = nodeIds[1]; // in- node
  const nOut = nodeIds[2]; // out node
  const nVccP = nodeIds[3]; // Vcc+ node
  const nVccN = nodeIds[4]; // Vcc- node

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
    nodeIndices: [nInp, nInn, nOut, nVccP, nVccN],
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
      vVccP = readNode(voltages, nVccP);
      vVccN = readNode(voltages, nVccN);

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
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildOpAmpPinDeclarations(),
  propertyDefs: OPAMP_PROPERTY_DEFS,
  attributeMap: OPAMP_ATTRIBUTE_MAPPINGS,

  helpText:
    "Ideal Op-Amp — 5-terminal nonlinear element (in+, in-, out, Vcc+, Vcc-). " +
    "High-gain voltage amplifier with output saturation at supply rails.",

  factory(props: PropertyBag): OpAmpElement {
    return new OpAmpElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    return createOpAmpElement(nodeIds, branchIdx, props);
  },
};
