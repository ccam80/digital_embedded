/**
 * DAC — N-bit Digital-to-Analog Converter.
 *
 * Converts an N-bit digital input code to an analog output voltage.
 * Digital inputs are read via DigitalInputPinModel threshold detection.
 * The analog output is modelled as a Norton equivalent (voltage source
 * with output resistance R_out):
 *
 *   V_out = V_ref · code / 2^N          (unipolar)
 *   V_out = V_ref · (2·code/2^N - 1)   (bipolar, symmetric about 0)
 *
 * Output Norton stamp:
 *   G_out = 1/R_out  → diagonal at nOut
 *   I_out = V_out · G_out → RHS at nOut
 *
 * Pin order (nodeIds):
 *   [D0, D1, ..., D(N-1), VREF, OUT, GND]
 *
 * Indices in nodeIds array:
 *   0 .. N-1    → digital input pins D0..D(N-1)
 *   N           → VREF
 *   N+1         → OUT
 *   N+2         → GND
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
import { DigitalInputPinModel } from "../../analog/digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";

// ---------------------------------------------------------------------------
// Pin declarations — variable N, built at factory time
// ---------------------------------------------------------------------------

/**
 * Build pin declarations for an N-bit DAC.
 *
 * Layout:
 *   D0..D(N-1) — digital inputs on the left side, stacked vertically
 *   VREF       — voltage reference input
 *   OUT        — analog output (right side)
 *   GND        — ground reference
 */
function buildDACPinDeclarations(bits: number): PinDeclaration[] {
  const pins: PinDeclaration[] = [];

  // Digital input pins D0..D(N-1) on the left, evenly spaced
  for (let i = 0; i < bits; i++) {
    pins.push({
      direction: PinDirection.INPUT,
      label: `D${i}`,
      defaultBitWidth: 1,
      position: { x: 0, y: i - Math.floor(bits / 2) },
      isNegatable: false,
      isClockCapable: false,
    });
  }

  // VREF — reference voltage input
  pins.push({
    direction: PinDirection.INPUT,
    label: "VREF",
    defaultBitWidth: 1,
    position: { x: 2, y: -Math.floor(bits / 2) - 1 },
    isNegatable: false,
    isClockCapable: false,
  });

  // OUT — analog output
  pins.push({
    direction: PinDirection.OUTPUT,
    label: "OUT",
    defaultBitWidth: 1,
    position: { x: 4, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  });

  // GND — ground reference
  pins.push({
    direction: PinDirection.INPUT,
    label: "GND",
    defaultBitWidth: 1,
    position: { x: 2, y: Math.floor(bits / 2) + 1 },
    isNegatable: false,
    isClockCapable: false,
  });

  return pins;
}

// ---------------------------------------------------------------------------
// DACElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DACElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DAC", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bits = this._properties.getOrDefault<number>("bits", 8);
    return this.derivePins(buildDACPinDeclarations(bits), []);
  }

  getBoundingBox(): Rect {
    const bits = this._properties.getOrDefault<number>("bits", 8);
    const height = Math.max(bits + 2, 4);
    return {
      x: this.position.x,
      y: this.position.y - Math.floor(height / 2),
      width: 4,
      height,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    const bits = this._properties.getOrDefault<number>("bits", 8);
    const label = this._properties.getOrDefault<string>("label", "");
    const halfH = Math.floor(bits / 2) + 1;

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Rectangular body
    ctx.drawRect(0, -halfH, 4, halfH * 2);

    // Label "DAC" centered inside
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("DAC", 2, 0, { horizontal: "center", vertical: "center" });

    // Bit count label
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText(`${bits}-bit`, 2, 0.8, { horizontal: "center", vertical: "center" });

    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 2, -halfH - 0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "N-bit DAC — converts a digital input code to an analog output voltage. " +
      "V_out = V_ref · code / 2^N (unipolar) or V_ref · (2·code/2^N − 1) (bipolar)."
    );
  }
}

// ---------------------------------------------------------------------------
// Default pin electrical spec for digital inputs
// ---------------------------------------------------------------------------

/** CMOS 3.3V default pin electrical for DAC digital inputs. */
function makeInputPinSpec(vRef: number): ResolvedPinElectrical {
  const vIH = vRef * 0.7;
  const vIL = vRef * 0.3;
  return {
    rOut:  50,
    cOut:  5e-12,
    rIn:   1e7,
    cIn:   5e-12,
    vOH:   vRef,
    vOL:   0.0,
    vIH,
    vIL,
    rHiZ:  1e7,
  };
}

// ---------------------------------------------------------------------------
// createDACElement — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA element for an N-bit DAC.
 *
 * Node assignment in nodeIds array (all 1-based, 0 = ground):
 *   nodeIds[0..N-1] → digital input pins D0..D(N-1)
 *   nodeIds[N]      → VREF node
 *   nodeIds[N+1]    → OUT node
 *   nodeIds[N+2]    → GND node (may be 0 if tied to MNA ground)
 */
function createDACElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const bits   = Math.max(1, Math.min(32, props.getOrDefault<number>("bits", 8)));
  const vRef   = props.getOrDefault<number>("vRef", 5.0);
  const mode   = props.getOrDefault<string>("mode", "unipolar");
  const rOut   = Math.max(props.getOrDefault<number>("rOut", 100), 1e-9);
  const G_out  = 1 / rOut;

  const maxCode = Math.pow(2, bits);

  // Node indices from the nodeIds array
  const nVref = nodeIds[bits];       // VREF node (1-based)
  const nOut  = nodeIds[bits + 1];   // OUT node (1-based)
  // GND node at nodeIds[bits+2] — not directly stamped (MNA ground handled implicitly)

  // DigitalInputPinModel instances — one per bit
  const inputSpec = makeInputPinSpec(vRef);
  const inputModels: DigitalInputPinModel[] = [];
  for (let i = 0; i < bits; i++) {
    const model = new DigitalInputPinModel(inputSpec);
    const nD = nodeIds[i];
    if (nD > 0) {
      model.init(nD, 0);
    }
    inputModels.push(model);
  }

  // Current output voltage (updated by updateOperatingPoint)
  let _vOut = 0;

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  function computeOutputVoltage(voltages: Float64Array): number {
    const vRefNow = readNode(voltages, nVref);

    // Build digital code from input pin threshold detection
    let code = 0;
    for (let i = 0; i < bits; i++) {
      const nD = nodeIds[i];
      const vD = readNode(voltages, nD);
      const logic = inputModels[i].readLogicLevel(vD);
      // Treat undefined (indeterminate) as LOW for DAC conversion
      const bit = logic === true ? 1 : 0;
      code |= (bit << i);
    }

    if (mode === "bipolar") {
      // Bipolar: symmetric, range [-vRef, +vRef]
      // V_out = vRef · (2·code/2^N - 1)
      return vRefNow * (2 * code / maxCode - 1);
    } else {
      // Unipolar: range [0, vRef · (2^N-1)/2^N]
      return vRefNow * code / maxCode;
    }
  }

  return {
    nodeIndices: nodeIds,
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    stamp(solver: SparseSolver): void {
      // Stamp G_out from OUT to GND (Norton output resistance)
      if (nOut > 0) {
        solver.stamp(nOut - 1, nOut - 1, G_out);
      }
      // Stamp input loading for each digital input pin
      for (let i = 0; i < bits; i++) {
        const nD = nodeIds[i];
        if (nD > 0) {
          inputModels[i].stamp(solver);
        }
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // Norton current source: I = V_out · G_out injected at OUT node
      if (nOut > 0) {
        solver.stampRHS(nOut - 1, _vOut * G_out);
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      _vOut = computeOutputVoltage(voltages);
    },

    stampCompanion(
      solver: SparseSolver,
      dt: number,
      method: IntegrationMethod,
      voltages: Float64Array,
    ): void {
      // Stamp C_in companion model for each digital input
      for (let i = 0; i < bits; i++) {
        const nD = nodeIds[i];
        if (nD > 0) {
          const vD = readNode(voltages, nD);
          inputModels[i].stampCompanion(solver, dt, method);
          inputModels[i].updateCompanion(dt, method, vD);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DAC_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bits",
    type: PropertyType.INT,
    label: "Resolution (bits)",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Number of digital input bits N. Output has 2^N levels. Default 8.",
  },
  {
    key: "vRef",
    type: PropertyType.INT,
    label: "Reference voltage V_ref (V)",
    defaultValue: 5.0,
    description: "Full-scale reference voltage. Default 5.0 V.",
  },
  {
    key: "mode",
    type: PropertyType.STRING,
    label: "Mode",
    defaultValue: "unipolar",
    description: "'unipolar' (0 to V_ref) or 'bipolar' (−V_ref to +V_ref). Default 'unipolar'.",
  },
  {
    key: "rOut",
    type: PropertyType.INT,
    label: "Output resistance R_out (Ω)",
    defaultValue: 100,
    min: 1e-9,
    description: "Output impedance of the DAC drive circuit. Default 100 Ω.",
  },
  {
    key: "settlingTime",
    type: PropertyType.INT,
    label: "Settling time (s)",
    defaultValue: 1e-6,
    description: "Settling time to final value after code change. Default 1 µs.",
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

const DAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits",    propertyKey: "bits",        convert: (v) => parseInt(v, 10) },
  { xmlName: "VRef",    propertyKey: "vRef",        convert: (v) => parseFloat(v) },
  { xmlName: "Mode",    propertyKey: "mode",        convert: (v) => v },
  { xmlName: "ROut",    propertyKey: "rOut",        convert: (v) => parseFloat(v) },
  { xmlName: "Label",   propertyKey: "label",       convert: (v) => v },
];

// ---------------------------------------------------------------------------
// DACDefinition
// ---------------------------------------------------------------------------

export const DACDefinition: ComponentDefinition = {
  name: "DAC",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildDACPinDeclarations(8),
  propertyDefs: DAC_PROPERTY_DEFS,
  attributeMap: DAC_ATTRIBUTE_MAPPINGS,

  helpText:
    "N-bit DAC — converts digital input code to analog output voltage. " +
    "Pins: D0..D(N-1) (digital inputs), VREF, OUT, GND.",

  factory(props: PropertyBag): DACElement {
    return new DACElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    return createDACElement(nodeIds, branchIdx, props);
  },
};
