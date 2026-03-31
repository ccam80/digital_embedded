/**
 * PlacementMode — manages the ghost-element placement interaction.
 *
 * When the user selects a component from the palette, placement mode is entered.
 * A ghost image of the component follows the cursor (snapped to grid). Click
 * places the component. R rotates, M mirrors, Escape cancels. After placing,
 * the mode stays active so the user can place multiple copies (Digital behavior).
 *
 * Also supports paste-placement: a group of clipboard entries follows the cursor
 * as ghosts. R/M rotate/mirror the entire group. Click places all elements and
 * wires, then exits placement mode.
 */

import type { Point } from "@/core/renderer-interface";
import type { CircuitElement } from "@/core/element";
import type { Rotation } from "@/core/pin";
import { createSeededBag, type ComponentDefinition } from "@/core/registry";
import type { Circuit } from "@/core/circuit";
import { snapToGrid } from "@/editor/coordinates";
import type { ClipboardData } from "@/editor/edit-operations";

/** The grid size for snapping during placement — 1 grid unit. */
const PLACEMENT_GRID_SIZE = 1;

/** Snapshot of ghost element state, exposed for rendering the overlay. */
interface GhostState {
  readonly element: CircuitElement;
  readonly position: Point;
  readonly rotation: Rotation;
  readonly mirror: boolean;
}

/**
 * Controls placement mode for a single component type or a pasted group.
 *
 * Lifecycle (single component):
 *   start(definition) → active
 *   updateCursor(point) → ghost moves
 *   rotate() / mirror() → ghost orientation changes
 *   place(circuit) → element added, mode stays active
 *   cancel() → inactive
 *
 * Lifecycle (paste group):
 *   startPaste(clipboard) → active, isPasteMode() = true
 *   updateCursor(point) → all ghosts move
 *   rotate() / mirror() → entire group rotates/mirrors
 *   getTransformedClipboard() → caller uses with pasteFromClipboard
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

  // Paste-placement state
  private _pasteClipboard: ClipboardData | undefined = undefined;
  private _groupRotations: number = 0; // 0–3 quarter-turns applied to the group
  private _groupMirror: boolean = false;

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
    this._pasteClipboard = undefined;
    this._groupRotations = 0;
    this._groupMirror = false;
    this._ghost = this._buildGhost();
    this._active = true;
  }

  /**
   * Enter paste-placement mode for a clipboard group.
   * All entries follow the cursor as ghosts. R/M rotate/mirror the group.
   */
  startPaste(clipboard: ClipboardData): void {
    this._pasteClipboard = clipboard;
    this._definition = undefined;
    this._ghost = undefined;
    this._position = { x: 0, y: 0 };
    this._rotation = 0;
    this._mirror = false;
    this._groupRotations = 0;
    this._groupMirror = false;
    this._lastPlaced = undefined;
    this._active = true;
  }

  /**
   * Returns true when in paste-placement mode (group of clipboard entries).
   */
  isPasteMode(): boolean {
    return this._pasteClipboard !== undefined && this._active;
  }

  /**
   * Move the ghost(s) to the grid-snapped position nearest the given world point.
   */
  updateCursor(worldPoint: Point): void {
    if (!this._active) return;
    this._position = snapToGrid(worldPoint, PLACEMENT_GRID_SIZE);
    if (this._definition !== undefined) {
      this._ghost = this._buildGhost();
    }
  }

  /**
   * Rotate the ghost 90° clockwise (cycles 0→1→2→3→0).
   * In paste mode, rotates the entire group.
   */
  rotate(): void {
    if (!this._active) return;
    if (this._pasteClipboard) {
      this._groupRotations = (this._groupRotations + 1) % 4;
      return;
    }
    this._rotation = ((this._rotation + 1) % 4) as Rotation;
    this._ghost = this._buildGhost();
  }

  /**
   * Toggle horizontal mirror on the ghost.
   * In paste mode, mirrors the entire group.
   */
  mirror(): void {
    if (!this._active) return;
    if (this._pasteClipboard) {
      this._groupMirror = !this._groupMirror;
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
   *
   * Not valid in paste mode — use getTransformedClipboard() instead.
   */
  place(_circuit?: Circuit): CircuitElement {
    if (!this._active || this._definition === undefined) {
      throw new Error("PlacementMode: cannot place when not active");
    }

    const props = createSeededBag(this._definition);
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
    this._pasteClipboard = undefined;
    this._groupRotations = 0;
    this._groupMirror = false;
  }

  /**
   * Returns true when placement mode is active.
   */
  isActive(): boolean {
    return this._active;
  }

  /**
   * Returns the current ghost state for the renderer, or undefined when not active.
   * For paste mode, returns the first ghost (use getGhosts() for all).
   */
  getGhost(): GhostState | undefined {
    if (!this._active) return undefined;
    if (this._pasteClipboard) {
      const ghosts = this.getGhosts();
      return ghosts.length > 0 ? ghosts[0] : undefined;
    }
    if (this._ghost === undefined) return undefined;
    return {
      element: this._ghost,
      position: { x: this._position.x, y: this._position.y },
      rotation: this._rotation,
      mirror: this._mirror,
    };
  }

  /**
   * Returns all ghost states for rendering. Works for both single-component
   * placement (returns one ghost) and paste-placement (returns all ghosts).
   */
  getGhosts(): GhostState[] {
    if (!this._active) return [];
    if (this._pasteClipboard) {
      return this._buildPasteGhosts();
    }
    if (this._ghost) {
      return [{
        element: this._ghost,
        position: { x: this._position.x, y: this._position.y },
        rotation: this._rotation,
        mirror: this._mirror,
      }];
    }
    return [];
  }

  /**
   * Returns wire ghost positions for paste-placement rendering.
   * Each wire is in absolute world coordinates.
   */
  getPasteWireGhosts(): Array<{ start: Point; end: Point }> {
    if (!this._active || !this._pasteClipboard) return [];
    return this._pasteClipboard.wires.map(w => {
      const start = this._transformRelPoint(w.startRel);
      const end = this._transformRelPoint(w.endRel);
      return {
        start: { x: this._position.x + start.x, y: this._position.y + start.y },
        end: { x: this._position.x + end.x, y: this._position.y + end.y },
      };
    });
  }

  /**
   * Returns a ClipboardData with all relative positions and element rotations
   * transformed by the current group rotation/mirror. The caller passes this
   * to pasteFromClipboard() together with the current cursor position.
   */
  getTransformedClipboard(): ClipboardData {
    if (!this._pasteClipboard) {
      throw new Error("PlacementMode: not in paste mode");
    }
    const entries = this._pasteClipboard.entries.map(entry => {
      const pos = this._transformRelPoint(entry.relativePosition);
      let rot = entry.rotation;
      let mir = entry.mirror;
      rot = ((rot + this._groupRotations) % 4) as Rotation;
      if (this._groupMirror) mir = !mir;
      return { ...entry, relativePosition: pos, rotation: rot, mirror: mir };
    });
    const wires = this._pasteClipboard.wires.map(w => ({
      startRel: this._transformRelPoint(w.startRel),
      endRel: this._transformRelPoint(w.endRel),
    }));
    return { entries, wires };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Transform a relative point by the current group rotation and mirror.
   * 90° CW in screen coords (Y-down): (x, y) → (-y, x).
   */
  private _transformRelPoint(p: { x: number; y: number }): { x: number; y: number } {
    let { x, y } = p;
    for (let i = 0; i < this._groupRotations; i++) {
      const tmp = x;
      x = -y;
      y = tmp;
    }
    if (this._groupMirror) {
      x = -x;
    }
    return { x, y };
  }

  /**
   * Build ghost elements for all paste clipboard entries at their
   * transformed positions relative to the cursor.
   */
  private _buildPasteGhosts(): GhostState[] {
    if (!this._pasteClipboard) return [];
    return this._pasteClipboard.entries.map(entry => {
      const pos = this._transformRelPoint(entry.relativePosition);
      const props = entry.properties.clone();
      const el = entry.definition.factory(props);
      let rot = entry.rotation;
      let mir = entry.mirror;
      rot = ((rot + this._groupRotations) % 4) as Rotation;
      if (this._groupMirror) mir = !mir;
      el.position = { x: this._position.x + pos.x, y: this._position.y + pos.y };
      el.rotation = rot;
      el.mirror = mir;
      return {
        element: el,
        position: el.position,
        rotation: el.rotation,
        mirror: el.mirror,
      };
    });
  }

  /**
   * Construct a fresh ghost CircuitElement from the current definition and
   * orientation state. The ghost's position, rotation, and mirror are applied
   * so the renderer can draw it at the correct location.
   */
  private _buildGhost(): CircuitElement {
    const def = this._definition!;
    const props = createSeededBag(def);
    const element = def.factory(props);
    element.position = { x: this._position.x, y: this._position.y };
    element.rotation = this._rotation;
    element.mirror = this._mirror;
    return element;
  }
}
