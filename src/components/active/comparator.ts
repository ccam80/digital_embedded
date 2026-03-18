/**
 * Analog Comparator component.
 *
 * Similar to an op-amp but optimized for switching speed: no linear region,
 * open-collector or push-pull output, optional input hysteresis (Schmitt
 * window), and an input offset voltage (vos).
 *
 * Open-collector model (default):
 *   - Output active (sinking):  R_sat to ground  → output pulled LOW
 *   - Output inactive (off):    R_off to ground  → output pulled HIGH by
 *                                                   external resistor
 *
 * Push-pull model:
 *   - Stamps a Norton current source driving the output to V_OH or V_OL
 *     through R_out (same model as DigitalOutputPinModel, but simpler).
 *
 * Hysteresis:
 *   - Two thresholds derived from the reference voltage and hysteresis band:
 *       V_TH = V_ref + vos + hysteresis/2   (trip on rising V+)
 *       V_TL = V_ref + vos - hysteresis/2   (trip on falling V+)
 *   - State is held until the input crosses the opposite threshold.
 *
 * Response time is modelled as a single-pole RC filter on the internal
 * _outputHigh state: the effective output conductance ramps between the
 * saturated and off values with time constant responseTime.
 *
 * Node assignment:
 *   nodeIds[0] = V+ (non-inverting input)
 *   nodeIds[1] = V- (inverting input / reference)
 *   nodeIds[2] = out (output)
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
import type { AnalogElement, IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildComparatorPinDeclarations(): PinDeclaration[] {
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
  ];
}

// ---------------------------------------------------------------------------
// ComparatorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ComparatorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AnalogComparator", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildComparatorPinDeclarations(), []);
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

    // Triangle body pointing right (same as op-amp)
    ctx.drawLine(0, -2, 0, 2);
    ctx.drawLine(0, -2, 4, 0);
    ctx.drawLine(0, 2, 4, 0);

    // + label at non-inverting input
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("+", 0.5, -1, { horizontal: "left", vertical: "center" });

    // - label at inverting input
    ctx.drawText("−", 0.5, 1, { horizontal: "left", vertical: "center" });

    // "CMP" indicator
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("CMP", 2, 0.3, { horizontal: "center", vertical: "center" });

    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 2, -2.3, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Analog Comparator — 3-terminal element (in+, in-, out). " +
      "Output switches based on whether V+ > V- with optional hysteresis. " +
      "Open-collector output requires external pull-up; push-pull drives directly."
    );
  }
}

// ---------------------------------------------------------------------------
// createComparatorElement — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for a comparator.
 *
 * Open-collector output model:
 *   When active (output sinks current): stamp G_sat = 1/rSat between out and ground.
 *   When inactive (output off):         stamp G_off = 1/R_OFF between out and ground.
 *
 * Push-pull output model:
 *   Norton equivalent: G_out = 1/rSat; I_norton = V_target * G_out at out node.
 *
 * The response time is implemented by tracking a continuous _outputWeight in
 * [0.0, 1.0] that blends between the inactive and active conductance values.
 * At each timestep the weight moves toward its target at rate 1/responseTime.
 *
 * Node IDs are 1-based; solver rows/cols are 0-based (nodeId - 1).
 */
function createComparatorElement(
  nodeIds: number[],
  props: PropertyBag,
): AnalogElement {
  const hysteresis    = Math.max(props.getOrDefault<number>("hysteresis",    0),     0);
  const vos           = props.getOrDefault<number>("vos",           0.001);
  const rSat          = Math.max(props.getOrDefault<number>("rSat",          50),    1e-9);
  const outputType    = props.getOrDefault<string>("outputType",    "open-collector");
  const responseTime  = Math.max(props.getOrDefault<number>("responseTime",  1e-6),  1e-12);

  const R_OFF = 1e9; // open-collector off-state impedance (1 GΩ)

  const G_sat = 1 / rSat;
  const G_off = 1 / R_OFF;

  const nInp = nodeIds[0]; // V+ node (1-based)
  const nInn = nodeIds[1]; // V- node (1-based)
  const nOut = nodeIds[2]; // out node (1-based)

  // Hysteresis state: true when output is active (open-collector sinking)
  let _outputActive = false;

  // Continuous blend weight: 0.0 = fully inactive, 1.0 = fully active
  // Used to model response-time delay via a first-order filter.
  let _outputWeight = 0.0;

  // Effective conductance stamped on the output node (updated each NR iter)
  let _gEff = G_off;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  function computeGeff(): number {
    // Blend conductance according to current weight
    return G_off + _outputWeight * (G_sat - G_off);
  }

  return {
    nodeIndices: [nInp, nInn, nOut],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(solver: SparseSolver): void {
      // Linear part: stamp the effective conductance between out and ground.
      // This is re-evaluated every NR iteration via stampNonlinear to track
      // the current output state.
      if (nOut > 0) {
        solver.stamp(nOut - 1, nOut - 1, _gEff);
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // Re-stamp the output conductance at the current operating point.
      const gNew = computeGeff();
      if (nOut > 0) {
        solver.stamp(nOut - 1, nOut - 1, gNew - _gEff);
      }
      _gEff = gNew;

      // Push-pull: add Norton current source to drive output toward V_OH or V_OL.
      if (outputType === "push-pull" && nOut > 0) {
        const vTarget = _outputActive ? 0.0 : 3.3;
        solver.stampRHS(nOut - 1, vTarget * _gEff);
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vInp = readNode(voltages, nInp);
      const vInn = readNode(voltages, nInn);
      const vDiff = vInp - vInn - vos;

      // Hysteresis comparison with dead band
      const halfHyst = hysteresis / 2;
      if (_outputActive) {
        // Currently active (sinking); stays active until V+ drops well below V-
        if (vDiff < -halfHyst) {
          _outputActive = false;
          _outputWeight = 0.0;
        }
      } else {
        // Currently inactive; activates when V+ exceeds V-
        if (vDiff > halfHyst) {
          _outputActive = true;
          _outputWeight = 1.0;
        }
      }
    },

    stampCompanion(
      solver: SparseSolver,
      dt: number,
      _method: IntegrationMethod,
      _voltages: Float64Array,
    ): void {
      // Update _outputWeight toward its target using first-order Euler step.
      // This models the propagation delay specified by responseTime.
      const target = _outputActive ? 1.0 : 0.0;
      const tau = responseTime;
      const alpha = dt / (tau + dt); // first-order low-pass coefficient
      _outputWeight = _outputWeight + alpha * (target - _outputWeight);

      // Re-stamp the (now possibly updated) conductance
      const gNew = computeGeff();
      if (nOut > 0) {
        solver.stamp(nOut - 1, nOut - 1, gNew - _gEff);
      }
      _gEff = gNew;
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const COMPARATOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "hysteresis",
    type: PropertyType.INT,
    label: "Hysteresis (V)",
    defaultValue: 0,
    min: 0,
    description: "Hysteresis band width in volts (0 = no hysteresis). Default 0 V.",
  },
  {
    key: "vos",
    type: PropertyType.INT,
    label: "Input offset voltage (V)",
    defaultValue: 0.001,
    description: "Input offset voltage in volts. Default 1 mV.",
  },
  {
    key: "rSat",
    type: PropertyType.INT,
    label: "Saturation resistance (Ω)",
    defaultValue: 50,
    min: 1e-9,
    description: "Output saturation resistance in ohms (open-collector on-state). Default 50 Ω.",
  },
  {
    key: "outputType",
    type: PropertyType.STRING,
    label: "Output type",
    defaultValue: "open-collector",
    description: "Output topology: 'open-collector' or 'push-pull'. Default open-collector.",
  },
  {
    key: "responseTime",
    type: PropertyType.INT,
    label: "Response time (s)",
    defaultValue: 1e-6,
    min: 1e-12,
    description: "Propagation delay modelled as first-order filter time constant. Default 1 µs.",
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

const COMPARATOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "hysteresis",   propertyKey: "hysteresis",   convert: (v) => parseFloat(v) },
  { xmlName: "vos",          propertyKey: "vos",          convert: (v) => parseFloat(v) },
  { xmlName: "rSat",         propertyKey: "rSat",         convert: (v) => parseFloat(v) },
  { xmlName: "outputType",   propertyKey: "outputType",   convert: (v) => v },
  { xmlName: "responseTime", propertyKey: "responseTime", convert: (v) => parseFloat(v) },
  { xmlName: "Label",        propertyKey: "label",        convert: (v) => v },
];

// ---------------------------------------------------------------------------
// AnalogComparatorDefinition
// ---------------------------------------------------------------------------

export const AnalogComparatorDefinition: ComponentDefinition = {
  name: "AnalogComparator",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildComparatorPinDeclarations(),
  propertyDefs: COMPARATOR_PROPERTY_DEFS,
  attributeMap: COMPARATOR_ATTRIBUTE_MAPPINGS,

  helpText:
    "Analog Comparator — 3-terminal (in+, in-, out). " +
    "Switches output based on V+ vs V-. Open-collector output requires external pull-up. " +
    "Optional hysteresis prevents output chatter on noisy inputs.",

  factory(props: PropertyBag): ComparatorElement {
    return new ComparatorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    _branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    return createComparatorElement(nodeIds, props);
  },
};
