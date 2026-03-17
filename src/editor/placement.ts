/**
 * PlacementMode — manages the ghost-element placement interaction.
 *
 * When the user selects a component from the palette, placement mode is entered.
 * A ghost image of the component follows the cursor (snapped to grid). Click
 * places the component. R rotates, M mirrors, Escape cancels. After placing,
 * the mode stays active so the user can place multiple copies (Digital behavior).
 */

import type { Point } from "@/core/renderer-interface";
import type { CircuitElement } from "@/core/element";
import type { Rotation } from "@/core/pin";
import type { ComponentDefinition } from "@/core/registry";
import type { Circuit } from "@/core/circuit";
import { snapToGrid } from "@/editor/coordinates";
import { PropertyBag } from "@/core/properties";

/** The grid size for snapping during placement — 1 grid unit. */
const PLACEMENT_GRID_SIZE = 1;

/** Snapshot of ghost element state, exposed for rendering the overlay. */
export interface GhostState {
  readonly element: CircuitElement;
  readonly position: Point;
  readonly rotation: Rotation;
  readonly mirror: boolean;
}

/**
 * Controls placement mode for a single component type.
 *
 * Lifecycle:
 *   start(definition) → active
 *   updateCursor(point) → ghost moves
 *   rotate() / mirror() → ghost orientation changes
 *   place(circuit) → element added, mode stays active
 *   cancel() → inactive
 */
export class PlacementMode {
  private _active: boolean = false;
  private _definition: ComponentDefinition | undefined = undefined;
  private _position: Point = { x: 0, y: 0 };
  private _rotation: Rotation = 0;
  private _mirror: boolean = false;
  private _ghost: CircuitElement | undefined = undefined;
  private _lastPlaced: CircuitElement | undefined = undefined;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Enter placement mode for the given component type.
   * Creates an initial ghost element at the origin.
   */
  start(definition: ComponentDefinition): void {
    this._definition = definition;
    this._position = { x: 0, y: 0 };
    this._rotation = 0;
    this._mirror = false;
    this._lastPlaced = undefined;
    this._ghost = this._buildGhost();
    this._active = true;
  }

  /**
   * Move the ghost to the grid-snapped position nearest the given world point.
   */
  updateCursor(worldPoint: Point): void {
    if (!this._active || this._definition === undefined) {
      return;
    }
    this._position = snapToGrid(worldPoint, PLACEMENT_GRID_SIZE);
    this._ghost = this._buildGhost();
  }

  /**
   * Rotate the ghost 90° clockwise (cycles 0→1→2→3→0).
   */
  rotate(): void {
    if (!this._active) {
      return;
    }
    this._rotation = ((this._rotation + 1) % 4) as Rotation;
    this._ghost = this._buildGhost();
  }

  /**
   * Toggle horizontal mirror on the ghost.
   */
  mirror(): void {
    if (!this._active) {
      return;
    }
    this._mirror = !this._mirror;
    this._ghost = this._buildGhost();
  }

  /**
   * Instantiate a real element at the current ghost position and return it.
   * The element is NOT added to the circuit — the caller is responsible for
   * pushing a `placeComponent` EditCommand so placement is undoable.
   * The mode stays active for placing further copies.
   */
  place(_circuit?: Circuit): CircuitElement {
    if (!this._active || this._definition === undefined) {
      throw new Error("PlacementMode: cannot place when not active");
    }

    const props = new PropertyBag();
    const element = this._definition.factory(props);
    element.position = { x: this._position.x, y: this._position.y };
    element.rotation = this._rotation;
    element.mirror = this._mirror;

    this._lastPlaced = element;

    // Rebuild ghost so the overlay remains ready for the next placement
    this._ghost = this._buildGhost();

    return element;
  }

  /**
   * Returns the most recently placed element, or undefined if nothing has
   * been placed yet in this placement session.
   *
   * Used by the editor to detect clicks on the just-placed component
   * (which should exit placement mode and select/connect instead).
   */
  getLastPlaced(): CircuitElement | undefined {
    return this._lastPlaced;
  }

  /**
   * Exit placement mode. Ghost is discarded.
   */
  cancel(): void {
    this._active = false;
    this._definition = undefined;
    this._ghost = undefined;
    this._lastPlaced = undefined;
  }

  /**
   * Returns true when placement mode is active.
   */
  isActive(): boolean {
    return this._active;
  }

  /**
   * Returns the current ghost state for the renderer, or undefined when not active.
   */
  getGhost(): GhostState | undefined {
    if (!this._active || this._ghost === undefined) {
      return undefined;
    }
    return {
      element: this._ghost,
      position: { x: this._position.x, y: this._position.y },
      rotation: this._rotation,
      mirror: this._mirror,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Construct a fresh ghost CircuitElement from the current definition and
   * orientation state. The ghost's position, rotation, and mirror are applied
   * so the renderer can draw it at the correct location.
   */
  private _buildGhost(): CircuitElement {
    const def = this._definition!;
    const props = new PropertyBag();
    const element = def.factory(props);
    element.position = { x: this._position.x, y: this._position.y };
    element.rotation = this._rotation;
    element.mirror = this._mirror;
    return element;
  }
}
