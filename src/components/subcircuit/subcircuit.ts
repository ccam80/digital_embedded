/**
 * SubcircuitElement — a CircuitElement representing a nested circuit.
 *
 * Renders as a chip (labeled rectangle with interface pins). Pins are derived
 * dynamically from the subcircuit's In/Out components.
 *
 * Dynamic registration: when a subcircuit .dig is loaded, call
 * registerSubcircuit() to add a new ComponentDefinition to the registry. All
 * subcircuits are then accessible through the registry by name, uniformly
 * with built-in components.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
  type ComponentRegistry,
} from "../../core/registry.js";
import type { Circuit } from "../../core/circuit.js";
import { deriveInterfacePins } from "./pin-derivation.js";
import type { ShapeMode } from "./shape-renderer.js";
import {
  computeChipDimensions,
  drawDefaultShape,
  drawDILShape,
  drawCustomShape,
  drawLayoutShape,
} from "./shape-renderer.js";

// ---------------------------------------------------------------------------
// SubcircuitDefinition
// ---------------------------------------------------------------------------

/**
 * Holds the loaded circuit definition together with its derived pin layout
 * and the chosen shape mode for rendering.
 */
export interface SubcircuitDefinition {
  /** The loaded Circuit for this subcircuit. */
  circuit: Circuit;
  /** Derived interface pins (from In/Out components inside the circuit). */
  pinLayout: PinDeclaration[];
  /** Visual shape mode. */
  shapeMode: ShapeMode;
  /** Display name (typically the filename without extension). */
  name: string;
}

// ---------------------------------------------------------------------------
// SubcircuitElement
// ---------------------------------------------------------------------------

export class SubcircuitElement extends AbstractCircuitElement {
  private readonly _definition: SubcircuitDefinition;
  private readonly _pins: readonly Pin[];
  private readonly _width: number;
  private readonly _height: number;

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
    definition: SubcircuitDefinition,
  ) {
    super(typeId, instanceId, position, rotation, mirror, props);
    this._definition = definition;

    const inputPins = definition.pinLayout.filter(
      (p) => p.direction === PinDirection.INPUT,
    );
    const outputPins = definition.pinLayout.filter(
      (p) => p.direction === PinDirection.OUTPUT,
    );

    const { width, height } = computeChipDimensions(
      inputPins.length,
      outputPins.length,
    );
    this._width = width;
    this._height = height;

    const positionedPins = buildPositionedPinDeclarations(
      inputPins,
      outputPins,
      width,
      height,
    );

    this._pins = resolvePins(
      positionedPins,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: this._width,
      height: this._height,
    };
  }

  draw(ctx: RenderContext): void {

    ctx.save();

    const positionedPins = buildPositionedPinDeclarations(
      this._definition.pinLayout.filter((p) => p.direction === PinDirection.INPUT),
      this._definition.pinLayout.filter((p) => p.direction === PinDirection.OUTPUT),
      this._width,
      this._height,
    );

    switch (this._definition.shapeMode) {
      case "DEFAULT":
        drawDefaultShape(ctx, this._definition.name, positionedPins, this._width, this._height);
        break;
      case "DIL":
        drawDILShape(ctx, this._definition.name, positionedPins, this._width, this._height);
        break;
      case "CUSTOM":
        drawCustomShape(ctx, this._definition.name, positionedPins, this._width, this._height);
        break;
      case "LAYOUT":
        drawLayoutShape(ctx, this._definition.name, positionedPins, this._width, this._height);
        break;
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      `Subcircuit: ${this._definition.name}\n` +
      `Pins: ${this._definition.pinLayout.length} interface pins derived from In/Out components.\n` +
      "This component is flattened into its constituent gates before simulation."
    );
  }

  /** The loaded subcircuit definition (used by flattening and rendering). */
  get definition(): SubcircuitDefinition {
    return this._definition;
  }
}

// ---------------------------------------------------------------------------
// Position pins on chip faces
// ---------------------------------------------------------------------------

/**
 * Assign final positions to input and output pins on a chip rectangle.
 *
 * Input pins are placed on the left (west) face; output pins on the right
 * (east) face. Positions are computed to be evenly spaced, matching the
 * chip height produced by computeChipDimensions().
 */
function buildPositionedPinDeclarations(
  inputPins: readonly PinDeclaration[],
  outputPins: readonly PinDeclaration[],
  width: number,
  height: number,
): PinDeclaration[] {
  const positioned: PinDeclaration[] = [];

  const inputSpacing = inputPins.length > 0 ? (height - 1) / (inputPins.length + 1) : 0;
  inputPins.forEach((pin, i) => {
    positioned.push({
      ...pin,
      position: { x: 0, y: Math.round((i + 1) * inputSpacing * 10) / 10 + 0.5 },
    });
  });

  const outputSpacing = outputPins.length > 0 ? (height - 1) / (outputPins.length + 1) : 0;
  outputPins.forEach((pin, i) => {
    positioned.push({
      ...pin,
      position: { x: width, y: Math.round((i + 1) * outputSpacing * 10) / 10 + 0.5 },
    });
  });

  return positioned;
}

// ---------------------------------------------------------------------------
// No-op execute function (subcircuits are flattened before simulation)
// ---------------------------------------------------------------------------

export function executeSubcircuit(
  _index: number,
  _state: Uint32Array,
  _layout: ComponentLayout,
): void {
  // Subcircuits are inlined into the parent CompiledModel before simulation.
  // This function is never called during normal simulation.
}

// ---------------------------------------------------------------------------
// Dynamic registration
// ---------------------------------------------------------------------------

/**
 * Register a loaded subcircuit as a new ComponentDefinition in the registry.
 *
 * After registration, the subcircuit is accessible by name from the registry,
 * uniformly with built-in components. Subsequent placements of the subcircuit
 * use the registered factory to create SubcircuitElement instances.
 *
 * @param registry    The component registry to register into.
 * @param name        The name (typically filename without extension) used as the lookup key.
 * @param definition  The loaded subcircuit definition.
 */
export function registerSubcircuit(
  registry: ComponentRegistry,
  name: string,
  definition: SubcircuitDefinition,
): void {
  const propertyDefs: PropertyDefinition[] = [
    {
      key: "label",
      type: PropertyType.STRING,
      label: "Label",
      defaultValue: "",
      description: "Optional label override for this instance",
    },
  ];

  const attributeMap: AttributeMapping[] = [
    {
      xmlName: "Label",
      propertyKey: "label",
      convert: (v) => v,
    },
  ];

  const componentDef: ComponentDefinition = {
    name,
    typeId: -1,
    factory: (props: PropertyBag) =>
      new SubcircuitElement(
        name,
        crypto.randomUUID(),
        { x: 0, y: 0 },
        0,
        false,
        props,
        definition,
      ),
    executeFn: executeSubcircuit,
    pinLayout: definition.pinLayout,
    propertyDefs,
    attributeMap,
    category: ComponentCategory.SUBCIRCUIT,
    helpText:
      `Subcircuit: ${name}\n` +
      `Pins: ${definition.pinLayout.length} interface pins derived from In/Out components.\n` +
      "This component is flattened into its constituent gates before simulation.",
  };

  registry.register(componentDef);
}
