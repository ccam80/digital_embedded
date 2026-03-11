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
import type { Circuit, CustomShapeData } from "../../core/circuit.js";
import type { ShapeMode } from "./shape-renderer.js";
import {
  drawDefaultShape,
  drawDILShape,
  drawCustomShape,
  drawLayoutShape,
} from "./shape-renderer.js";
import { countPinsByFace } from "./pin-derivation.js";

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
  private readonly _effectiveShapeMode: ShapeMode;

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

    // Determine effective shape mode: instance override > definition default
    const instanceShapeType = props.getOrDefault<string>("shapeType", "");
    if (instanceShapeType && instanceShapeType !== "" && instanceShapeType !== "DEFAULT") {
      this._effectiveShapeMode = instanceShapeType as ShapeMode;
    } else {
      // DEFAULT means "use circuit's own shape type"; if that's also DEFAULT, fall back to SIMPLE
      const defMode = definition.shapeMode;
      this._effectiveShapeMode = (defMode === "DEFAULT") ? "SIMPLE" : defMode;
    }

    const chipWidth = definition.circuit.metadata.chipWidth ?? 3;
    const chipHeight = definition.circuit.metadata.chipHeight ?? 3;

    if (this._effectiveShapeMode === "LAYOUT") {
      // LAYOUT: faces from In/Out rotation, dimensions are max(pins+1, explicit attribute)
      const faceCounts = countPinsByFace(definition.pinLayout);
      this._width = Math.max(faceCounts.top + 1, faceCounts.bottom + 1, chipWidth);
      this._height = Math.max(faceCounts.left + 1, faceCounts.right + 1, chipHeight);
    } else {
      // DEFAULT/DIL/CUSTOM: all inputs on left, all outputs on right
      const inputCount = definition.pinLayout.filter(p => p.direction === PinDirection.INPUT).length;
      const outputCount = definition.pinLayout.filter(p => p.direction === PinDirection.OUTPUT).length;
      this._width = chipWidth;
      this._height = Math.max(inputCount, outputCount, 1);
    }

    const customShape = definition.circuit.metadata.customShape;
    let positionedPins: PinDeclaration[];

    if (this._effectiveShapeMode === "CUSTOM" && customShape && customShape.pins.size > 0) {
      positionedPins = buildCustomPinPositions(definition.pinLayout, customShape);
      const extents = computeCustomShapeExtents(customShape);
      this._width = extents.width;
      this._height = extents.height;
    } else {
      positionedPins = buildPositionedPinDeclarations(
        definition.pinLayout,
        this._width,
        this._height,
        this._effectiveShapeMode,
      );
    }

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
    if (this._effectiveShapeMode === "LAYOUT") {
      // LAYOUT chip rect: origin at (0,0), full width × height
      return {
        x: this.position.x,
        y: this.position.y,
        width: this._width,
        height: this._height,
      };
    }
    // DEFAULT/DIL/CUSTOM: chip rect has 0.5 border above and below pin area
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: this._width,
      height: this._height - 1 + 1, // pinRows - 1 + 2 * BORDER
    };
  }

  draw(ctx: RenderContext): void {

    ctx.save();

    const customShape = this._definition.circuit.metadata.customShape;
    let positionedPins: PinDeclaration[];

    if (this._effectiveShapeMode === "CUSTOM" && customShape && customShape.pins.size > 0) {
      positionedPins = buildCustomPinPositions(this._definition.pinLayout, customShape);
    } else {
      positionedPins = buildPositionedPinDeclarations(
        this._definition.pinLayout,
        this._width,
        this._height,
        this._effectiveShapeMode,
      );
    }

    switch (this._effectiveShapeMode) {
      case "DIL":
        drawDILShape(ctx, this._definition.name, positionedPins, this._width, this._height, this.rotation);
        break;
      case "CUSTOM":
        drawCustomShape(ctx, this._definition.name, positionedPins, this._width, this._height, this.rotation, customShape);
        break;
      case "LAYOUT":
        drawLayoutShape(ctx, this._definition.name, positionedPins, this._width, this._height, this.rotation);
        break;
      case "DEFAULT":
      case "SIMPLE":
      case "MINIMIZED":
      default:
        drawDefaultShape(ctx, this._definition.name, positionedPins, this._width, this._height, this.rotation);
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
 * Assign final positions to pins on a chip rectangle based on their face
 * and the shape mode.
 *
 * DEFAULT/DIL/CUSTOM: all inputs on left face, all outputs on right face,
 * sequential y positions (matching Digital's GenericShape).
 *
 * LAYOUT: faces from In/Out element rotation, pins distributed evenly across
 * the declared face length (matching Digital's LayoutShape).
 */
function buildPositionedPinDeclarations(
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
  shapeMode: ShapeMode,
): PinDeclaration[] {
  if (shapeMode === "LAYOUT") {
    return buildLayoutPositions(pins, width, height);
  }
  return buildDefaultPositions(pins, width, height);
}

/**
 * DEFAULT/DIL/CUSTOM: all inputs on left, all outputs on right.
 * Sequential y positions (0, 1, 2, ...).
 */
function buildDefaultPositions(
  pins: readonly PinDeclaration[],
  width: number,
  _height: number,
): PinDeclaration[] {
  const inputs: PinDeclaration[] = [];
  const outputs: PinDeclaration[] = [];

  for (const pin of pins) {
    if (pin.direction === PinDirection.INPUT) {
      inputs.push(pin);
    } else {
      outputs.push(pin);
    }
  }

  const positioned: PinDeclaration[] = [];

  // Inputs on left face: x=0, y=0,1,2,...
  for (let i = 0; i < inputs.length; i++) {
    positioned.push({ ...inputs[i], face: "left", position: { x: 0, y: i } });
  }
  // Outputs on right face: x=width, y=0,1,2,...
  for (let i = 0; i < outputs.length; i++) {
    positioned.push({ ...outputs[i], face: "right", position: { x: width, y: i } });
  }

  return positioned;
}

/**
 * LAYOUT: pins keep their rotation-derived face assignment and are
 * distributed evenly across the declared face length.
 *
 * Matches Digital's LayoutShape.PinList.createPosition() algorithm:
 *   delta = floor((length + 2) / (nPins + 1))
 *   span  = delta * (nPins - 1)
 *   start = floor((length - span) / 2)
 *   positions: start, start+delta, start+2*delta, ...
 */
function buildLayoutPositions(
  pins: readonly PinDeclaration[],
  width: number,
  height: number,
): PinDeclaration[] {
  type Face = "left" | "right" | "top" | "bottom";

  // Group by face, preserving sort order from deriveInterfacePins
  const groups: Record<Face, PinDeclaration[]> = {
    left: [], right: [], top: [], bottom: [],
  };
  for (const pin of pins) {
    const face: Face = pin.face ??
      (pin.direction === PinDirection.INPUT ? "left" : "right");
    groups[face].push(pin);
  }

  /**
   * Distribute N pins evenly across a face of the given length (in grid units).
   * Returns offset positions along the face axis.
   */
  function distribute(n: number, length: number): number[] {
    if (n === 0) return [];
    if (n === 1) {
      return [Math.floor(length / 2)];
    }
    const delta = Math.floor((length + 2) / (n + 1));
    const span = delta * (n - 1);
    const start = Math.floor((length - span) / 2);
    const positions: number[] = [];
    for (let i = 0; i < n; i++) {
      positions.push(start + i * delta);
    }
    return positions;
  }

  const positioned: PinDeclaration[] = [];

  // Left face: x=0, y distributed across height
  const leftY = distribute(groups.left.length, height);
  for (let i = 0; i < groups.left.length; i++) {
    positioned.push({ ...groups.left[i], position: { x: 0, y: leftY[i] } });
  }

  // Right face: x=width, y distributed across height
  const rightY = distribute(groups.right.length, height);
  for (let i = 0; i < groups.right.length; i++) {
    positioned.push({ ...groups.right[i], position: { x: width, y: rightY[i] } });
  }

  // Top face: y=0 (at chip edge, matching Java LayoutShape startPos=(0,0))
  // Java: top.createPosition(map, new Vector(0, 0), width) — pins AT the edge.
  const topX = distribute(groups.top.length, width);
  for (let i = 0; i < groups.top.length; i++) {
    positioned.push({ ...groups.top[i], position: { x: topX[i], y: 0 } });
  }

  // Bottom face: y=height (stub extends below chip), x distributed across width
  const bottomX = distribute(groups.bottom.length, width);
  for (let i = 0; i < groups.bottom.length; i++) {
    positioned.push({ ...groups.bottom[i], position: { x: bottomX[i], y: height } });
  }

  return positioned;
}

// ---------------------------------------------------------------------------
// CUSTOM shape pin positioning and extent computation
// ---------------------------------------------------------------------------

/**
 * Build pin declarations using positions from the custom shape data.
 * Each interface pin is looked up by name in the custom shape's pin map.
 * Pins not found in the custom shape map fall back to (0, 0).
 */
function buildCustomPinPositions(
  pins: readonly PinDeclaration[],
  customShape: CustomShapeData,
): PinDeclaration[] {
  return pins.map((pin) => {
    const customPin = customShape.pins.get(pin.label);
    if (customPin) {
      const face = customPin.pos.x === 0 ? "left" as const : "right" as const;
      return { ...pin, position: { x: customPin.pos.x, y: customPin.pos.y }, face };
    }
    return { ...pin, position: { x: 0, y: 0 }, face: "left" as const };
  });
}

/**
 * Compute width and height from the union of all custom pin positions
 * and drawable extents. Returns grid-unit dimensions.
 */
function computeCustomShapeExtents(customShape: CustomShapeData): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;

  for (const [, pin] of customShape.pins) {
    if (pin.pos.x > maxX) maxX = pin.pos.x;
    if (pin.pos.y > maxY) maxY = pin.pos.y;
  }

  for (const d of customShape.drawables) {
    switch (d.type) {
      case "line":
        if (d.p1.x > maxX) maxX = d.p1.x;
        if (d.p2.x > maxX) maxX = d.p2.x;
        if (d.p1.y > maxY) maxY = d.p1.y;
        if (d.p2.y > maxY) maxY = d.p2.y;
        break;
      case "circle":
        if (d.p1.x > maxX) maxX = d.p1.x;
        if (d.p2.x > maxX) maxX = d.p2.x;
        if (d.p1.y > maxY) maxY = d.p1.y;
        if (d.p2.y > maxY) maxY = d.p2.y;
        break;
      case "text":
        if (d.pos.x > maxX) maxX = d.pos.x;
        if (d.pos.y > maxY) maxY = d.pos.y;
        break;
      default:
        break;
    }
  }

  return { width: Math.max(maxX, 1), height: Math.max(maxY, 1) };
}

// ---------------------------------------------------------------------------
// No-op execute function (subcircuits are flattened before simulation)
// ---------------------------------------------------------------------------

export function executeSubcircuit(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
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
    {
      key: "shapeType",
      type: PropertyType.STRING,
      label: "Shape Type",
      defaultValue: "",
      description: "Shape mode override: DEFAULT, SIMPLE, DIL, LAYOUT, CUSTOM",
    },
  ];

  const attributeMap: AttributeMapping[] = [
    {
      xmlName: "Label",
      propertyKey: "label",
      convert: (v) => v,
    },
    {
      xmlName: "shapeType",
      propertyKey: "shapeType",
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
