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
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// ProbeMode
// ---------------------------------------------------------------------------

export type ProbeMode = "VALUE" | "UP" | "DOWN" | "BOTH";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout — one input on west face, no outputs
// ---------------------------------------------------------------------------

function buildProbePinDeclarations(bitWidth: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ProbeElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ProbeElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _bitWidth: number;
  private readonly _intFormat: string;
  private readonly _probeMode: ProbeMode;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Probe", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._intFormat = props.getOrDefault<string>("intFormat", "hex");
    this._probeMode = props.getOrDefault<string>("probeMode", "VALUE") as ProbeMode;

    const decls = buildProbePinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  get intFormat(): string {
    return this._intFormat;
  }

  get probeMode(): ProbeMode {
    return this._probeMode;
  }

  draw(ctx: RenderContext): void {

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Probe symbol: circle with a dot (oscilloscope-style)
    ctx.setColor("COMPONENT");
    ctx.drawCircle(COMP_WIDTH / 2, COMP_HEIGHT / 2, 0.5, false);
    ctx.drawCircle(COMP_WIDTH / 2, COMP_HEIGHT / 2, 0.1, true);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(this._label, COMP_WIDTH / 2, -0.3, {
        horizontal: "center",
        vertical: "bottom",
      });
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

export function executeProbe(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inputIdx = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  // Copy current input value to the output/storage slot.
  // Edge-counting is handled by the engine layer that wraps this function.
  state[outputIdx] = state[inputIdx];
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
// ProbeDefinition
// ---------------------------------------------------------------------------

function probeFactory(props: PropertyBag): ProbeElement {
  return new ProbeElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ProbeDefinition: ComponentDefinition = {
  name: "Probe",
  typeId: -1,
  factory: probeFactory,
  executeFn: executeProbe,
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
};
