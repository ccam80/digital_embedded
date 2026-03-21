/**
 * CircuitElement interface — the editor-facing object for every component type.
 *
 * Per Decision 1: CircuitElement has NO execute() method. No simulation logic.
 * Simulation is handled by standalone flat functions registered in ComponentDefinition.
 *
 * Per Decision 3: This is the visual model only. No signal values, no net IDs.
 *
 * The interface is engine-agnostic: any simulation backend (digital event-driven,
 * analog MNA, etc.) can reuse the same CircuitElement for rendering and property
 * editing — only the registered flat simulation functions differ.
 */

import type { Point, Rect, RenderContext } from "./renderer-interface.js";
import type { PinVoltageAccess } from "../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration } from "./pin.js";
import type { Rotation } from "./pin.js";
import {
  resolvePins,
  createInverterConfig,
  createClockConfig,
} from "./pin.js";
import type { PropertyBag, PropertyValue } from "./properties.js";
import { propertyBagToJson } from "./properties.js";

// ---------------------------------------------------------------------------
// SerializedElement — shape for JSON save/load
// ---------------------------------------------------------------------------

/**
 * The serialized form of a CircuitElement as it appears in a saved JSON circuit.
 *
 * Properties are stored as a plain object (SerializedPropertyBag).
 * Attribute mapping from .dig XML is handled separately by the parser.
 */
export interface SerializedElement {
  /** Component type name matching the registry. E.g. "And", "FlipflopD". */
  readonly typeId: string;
  /** Unique identifier for this instance within a circuit. */
  readonly instanceId: string;
  readonly position: Point;
  readonly rotation: Rotation;
  readonly mirror: boolean;
  /** Serialized property values — plain JSON-safe object. */
  readonly properties: Record<string, number | string | boolean | number[]>;
}

// ---------------------------------------------------------------------------
// CircuitElement interface
// ---------------------------------------------------------------------------

/**
 * The editor-facing contract for every component type.
 *
 * Responsibilities: identity, pin declarations, properties, rendering, serialization, help.
 * NOT responsible for: simulation, signal values, net IDs, or execution order.
 */
export interface CircuitElement {
  // --- Identity ---

  /**
   * Component type name as registered in the ComponentRegistry.
   * Matches the elementName used in .dig files. E.g. "And", "FlipflopD", "Out".
   */
  readonly typeId: string;

  /**
   * Instance-unique identifier within a circuit. Generated at creation time,
   * preserved through serialization for stable references (undo, cross-circuit links).
   */
  readonly instanceId: string;

  // --- Visual placement ---

  /** Grid position of the component's origin (top-left corner in default orientation). */
  position: Point;

  /**
   * Rotation in quarter-turns clockwise.
   * 0 = default (east-facing outputs), 1 = 90° CW, 2 = 180°, 3 = 270° CW.
   */
  rotation: Rotation;

  /**
   * Whether the component is mirrored horizontally (before rotation is applied).
   * Matches Digital's mirror attribute in .dig files.
   */
  mirror: boolean;

  // --- Pins ---

  /**
   * Returns the resolved Pin instances for this component, positioned in world
   * space relative to the component's current position and rotation.
   *
   * No simulation state on pins (Decision 6). The compiler assigns net IDs.
   */
  getPins(): readonly Pin[];

  // --- Properties ---

  /**
   * Returns the component's current property bag. The bag is mutable via set();
   * callers who need a snapshot for undo should call bag.clone().
   */
  getProperties(): PropertyBag;

  // --- Rendering ---

  /**
   * Draw the component using the engine-agnostic RenderContext.
   * Must not import Canvas2D, SVG, or any concrete renderer.
   *
   * The optional `signals` parameter provides per-pin voltage access for
   * analog components that want to color leads and bodies by node voltage.
   * Digital components ignore this parameter.
   */
  draw(ctx: RenderContext, signals?: PinVoltageAccess): void;

  /**
   * Bounding box of this component in world (grid) coordinates.
   * Used for hit-testing, selection marquee, and viewport culling.
   */
  getBoundingBox(): Rect;

  // --- Serialization ---

  /**
   * Serialize to a plain, JSON-safe object. Used by the JSON save path.
   * The .dig XML path uses the attribute mapping registered in ComponentDefinition.
   */
  serialize(): SerializedElement;

  // --- Help ---

  /**
   * Returns the help / documentation text for this component type.
   * Displayed in the property panel and tooltip help popups.
   */
  getHelpText(): string;

  // --- HGS attribute access ---

  /**
   * Map-like property read used by the HGS scripting interpreter and the
   * generic circuit resolution subsystem (ResolveGenerics).
   *
   * Returns the value for `name` from the component's properties, or
   * undefined if not present.
   */
  getAttribute(name: string): PropertyValue | undefined;
}

// ---------------------------------------------------------------------------
// AbstractCircuitElement — base class with common default implementations
// ---------------------------------------------------------------------------

/**
 * Base class providing default implementations for the parts of CircuitElement
 * that are uniform across component types. Component classes extend this and
 * override draw(), getPins(), getHelpText(), and any property-specific logic.
 *
 * Using a class here is justified: every component is a genuine CircuitElement.
 * The alternative (separate interface + standalone helpers) would duplicate
 * position/rotation/mirror handling identically in ~110 component files.
 */
export abstract class AbstractCircuitElement implements CircuitElement {
  readonly typeId: string;
  readonly instanceId: string;

  position: Point;
  rotation: Rotation;
  mirror: boolean;

  protected readonly _properties: PropertyBag;

  constructor(
    typeId: string,
    instanceId: string,
    position: Point,
    rotation: Rotation,
    mirror: boolean,
    properties: PropertyBag,
  ) {
    this.typeId = typeId;
    this.instanceId = instanceId;
    this.position = position;
    this.rotation = rotation;
    this.mirror = mirror;
    this._properties = properties;
  }

  getProperties(): PropertyBag {
    return this._properties;
  }

  getAttribute(name: string): PropertyValue | undefined {
    if (this._properties.has(name)) {
      return this._properties.get(name);
    }
    return undefined;
  }

  serialize(): SerializedElement {
    return {
      typeId: this.typeId,
      instanceId: this.instanceId,
      position: { x: this.position.x, y: this.position.y },
      rotation: this.rotation,
      mirror: this.mirror,
      properties: propertyBagToJson(this._properties),
    };
  }

  abstract getPins(): readonly Pin[];
  abstract draw(ctx: RenderContext, signals?: PinVoltageAccess): void;
  abstract getBoundingBox(): Rect;
  abstract getHelpText(): string;

  /**
   * Derive pins from declarations + current properties. Pins are in LOCAL
   * coordinates (rotation=0); pinWorldPosition() applies mirror/rotate/translate.
   *
   * Reads _inverterLabels from properties (the standard .dig inverterConfig
   * attribute mapping). Components override getPins() and call this helper.
   *
   * @param declarations  Static pin layout for this component variant.
   * @param clockLabels   Pin labels that are clock-capable (e.g. ["C"]).
   */
  protected derivePins(
    declarations: readonly PinDeclaration[],
    clockLabels: readonly string[] = [],
  ): Pin[] {
    const invLabels = this._properties.has("_inverterLabels")
      ? this._properties.get<string>("_inverterLabels").split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
          .map((s: string) => /^\d+$/.test(s) ? `In_${s}` : s)
      : [];
    return resolvePins(
      declarations,
      { x: 0, y: 0 },
      0,
      createInverterConfig(invLabels),
      createClockConfig(clockLabels),
    );
  }
}
