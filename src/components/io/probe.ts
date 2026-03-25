/**
 * Probe component — measurement point.
 *
 * Reads its input signal and adds it to the measurement/signal list.
 * Supports configurable display format (binary, decimal, hexadecimal, octal).
 * Supports probe modes: VALUE (show current value), UP (count rising edges),
 * DOWN (count falling edges), BOTH (count all edges).
 * No outputs — display only. executeFn copies input to internal store slot.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { drawUprightText } from "../../core/upright-text.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// ProbeMode
// ---------------------------------------------------------------------------

export type ProbeMode = "VALUE" | "UP" | "DOWN" | "BOTH";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pin layout — one input on west face, no outputs
// ---------------------------------------------------------------------------

function buildProbePinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ProbeElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ProbeElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Probe", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildProbePinDeclarations(bitWidth);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    // draw() is text-only — tsCallsToSegments produces no segments so
    // tsBounds collapses to (0,0,0,0). Starting y below 0 caused
    // overflow = tsBounds.minY - by0 = 0 - (-0.4) = 0.4.
    // Keep y=0 so the bbox top aligns with the collapsed draw bounds.
    return {
      x: this.position.x,
      y: this.position.y,
      width: 1.5,
      height: 0.8,
    };
  }

  get intFormat(): string {
    return this._properties.getOrDefault<string>("intFormat", "hex");
  }

  get probeMode(): ProbeMode {
    return this._properties.getOrDefault<string>("probeMode", "VALUE") as ProbeMode;
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    ctx.save();

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });

    if (label.length > 0) {
      drawUprightText(ctx, label, 0.1, -0.2, {
        horizontal: "left",
        vertical: "bottom",
      }, this.rotation);
      drawUprightText(ctx, "?", 0.1, 0.2, {
        horizontal: "left",
        vertical: "top",
      }, this.rotation);
    } else {
      drawUprightText(ctx, "?", 0.1, -0.05, {
        horizontal: "left",
        vertical: "middle",
      }, this.rotation);
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Probe — measurement point.\n" +
      "Reads the connected signal and adds it to the signal/measurement list.\n" +
      "probeMode controls what is displayed: VALUE (current value), UP (rising edge count),\n" +
      "DOWN (falling edge count), or BOTH (total edge count).\n" +
      "Display format is configurable: binary, decimal, hexadecimal, or octal."
    );
  }
}

// ---------------------------------------------------------------------------
// executeProbe — reads input into output slot (internal storage for display)
//
// The Probe has no output pins. The engine allocates an internal slot so the
// executeFn can store the current value for the measurement panel to read.
// In VALUE mode: store the raw input value.
// In edge-counting modes (UP/DOWN/BOTH): the engine manages the counter;
// the executeFn performs edge detection and increments the counter slot.
// ---------------------------------------------------------------------------

export function executeProbe(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputIdx = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  // Copy current input value to the output/storage slot.
  // Edge-counting is handled by the engine layer that wraps this function.
  state[wt[outputIdx]] = state[wt[inputIdx]];
}

// ---------------------------------------------------------------------------
// PROBE_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const PROBE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "intFormat",
    propertyKey: "intFormat",
    convert: (v) => v,
  },
  {
    xmlName: "ProbeMode",
    propertyKey: "probeMode",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const PROBE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown on the probe and in the signal list",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the measured signal",
  },
  {
    key: "intFormat",
    type: PropertyType.INTFORMAT,
    label: "Display format",
    defaultValue: "hex",
    enumValues: ["bin", "dec", "hex", "oct"],
    description: "Radix for displaying the measured value",
  },
  {
    key: "probeMode",
    type: PropertyType.ENUM,
    label: "Probe mode",
    defaultValue: "VALUE",
    enumValues: ["VALUE", "UP", "DOWN", "BOTH"],
    description: "What to display: current value or edge count",
  },
];

// ---------------------------------------------------------------------------
// Analog probe factory and element
// ---------------------------------------------------------------------------

class AnalogProbeElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;

  stamp(_solver: SparseSolver): void {
  }

  getVoltage(voltages: Float64Array): number {
    return voltages[this.pinNodeIds[0]];
  }

  getPinCurrents(_voltages: Float64Array): number[] {
    // Probe stamps nothing � it is a pure voltage measurement with no loading.
    // Return zero current for the single input pin.
    return [0];
  }
}

function probeAnalogFactory(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  _props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  return new AnalogProbeElement();
}

// ---------------------------------------------------------------------------
// ProbeDefinition
// ---------------------------------------------------------------------------

function probeFactory(props: PropertyBag): ProbeElement {
  return new ProbeElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ProbeDefinition: ComponentDefinition = {
  name: "Probe",
  typeId: -1,
  factory: probeFactory,
  pinLayout: buildProbePinDeclarations(1),
  propertyDefs: PROBE_PROPERTY_DEFS,
  attributeMap: PROBE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Probe — measurement point.\n" +
    "Reads the connected signal and adds it to the signal/measurement list.\n" +
    "probeMode controls what is displayed: VALUE (current value), UP (rising edge count),\n" +
    "DOWN (falling edge count), or BOTH (total edge count).\n" +
    "Display format is configurable: binary, decimal, hexadecimal, or octal.",
  models: {
    digital: { executeFn: executeProbe, inputSchema: ["in"], outputSchema: [] },
    analog: { factory: probeAnalogFactory },
  },
  defaultModel: "digital",
};
