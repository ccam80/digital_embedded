/**
 * FSM graphical editor — manages FSM-mode canvas rendering and interaction.
 *
 * Reuses the shared undo/redo stack from Phase 2. Provides tools for adding
 * states and transitions, moving states, deleting items, and editing properties.
 * Rendering and hit-testing are delegated to fsm-renderer and fsm-hit-test.
 */

import type { RenderContext } from "@/core/renderer-interface";
import type { EditCommand, UndoRedoStack } from "@/editor/undo-redo";
import type { FSM, FSMState, FSMTransition } from "@/fsm/model";
import {
  createFSM,
  addState,
  addTransition,
  removeState,
  removeTransition,
  findStateById,
  findTransitionsForState,
} from "@/fsm/model";
import { renderFSM } from "@/fsm/fsm-renderer";
import { hitTestFSM } from "@/fsm/fsm-hit-test";

export type FSMTool = "select" | "addState" | "addTransition";

export class FSMEditor {
  private _fsm: FSM;
  private readonly _undoRedo: UndoRedoStack;
  private _selectedStateIds: Set<string> = new Set();
  private _selectedTransitionIds: Set<string> = new Set();
  private _activeTool: FSMTool = "select";
  private _pendingTransitionSource: FSMState | undefined;
  private _dragState: FSMState | undefined;
  private _dragStartPos: { x: number; y: number } | undefined;

  constructor(undoRedo: UndoRedoStack, fsm?: FSM) {
    this._undoRedo = undoRedo;
    this._fsm = fsm ?? createFSM("Untitled");
  }

  get fsm(): FSM {
    return this._fsm;
  }

  get selectedStateIds(): ReadonlySet<string> {
    return this._selectedStateIds;
  }

  get selectedTransitionIds(): ReadonlySet<string> {
    return this._selectedTransitionIds;
  }

  get activeTool(): FSMTool {
    return this._activeTool;
  }

  setTool(tool: FSMTool): void {
    this._activeTool = tool;
    this._pendingTransitionSource = undefined;
  }

  /**
   * Render the FSM onto the given context.
   */
  render(ctx: RenderContext): void {
    renderFSM(ctx, this._fsm, this._selectedStateIds, this._selectedTransitionIds);
  }

  /**
   * Handle a click at canvas position (x, y).
   */
  handleClick(x: number, y: number): void {
    switch (this._activeTool) {
      case "addState":
        this._addStateAt(x, y);
        break;
      case "addTransition":
        this._handleTransitionClick(x, y);
        break;
      case "select":
        this._handleSelectClick(x, y);
        break;
    }
  }

  /**
   * Handle a double-click for property editing.
   * Returns the clicked item type and item, or undefined if nothing was hit.
   */
  handleDoubleClick(
    x: number,
    y: number,
  ): { type: "state"; state: FSMState } | { type: "transition"; transition: FSMTransition } | undefined {
    const hit = hitTestFSM(this._fsm, x, y);
    if (hit.type === "state") {
      return { type: "state", state: hit.state };
    }
    if (hit.type === "transition") {
      return { type: "transition", transition: hit.transition };
    }
    return undefined;
  }

  /**
   * Begin dragging a state from position (x, y).
   */
  handleMouseDown(x: number, y: number): void {
    if (this._activeTool !== "select") return;
    const hit = hitTestFSM(this._fsm, x, y);
    if (hit.type === "state") {
      this._dragState = hit.state;
      this._dragStartPos = { x: hit.state.position.x, y: hit.state.position.y };
    }
  }

  /**
   * Continue dragging: move the state to (x, y).
   */
  handleMouseMove(x: number, y: number): void {
    if (this._dragState === undefined) return;
    this._dragState.position.x = x;
    this._dragState.position.y = y;
  }

  /**
   * End dragging. Records an undo command for the position change.
   */
  handleMouseUp(x: number, y: number): void {
    if (this._dragState === undefined || this._dragStartPos === undefined) return;

    const state = this._dragState;
    const startPos = { ...this._dragStartPos };
    const endPos = { x, y };

    state.position.x = endPos.x;
    state.position.y = endPos.y;

    if (startPos.x !== endPos.x || startPos.y !== endPos.y) {
      const moveCommand: EditCommand = {
        description: `Move state ${state.name}`,
        execute(): void {
          state.position.x = endPos.x;
          state.position.y = endPos.y;
        },
        undo(): void {
          state.position.x = startPos.x;
          state.position.y = startPos.y;
        },
      };
      this._undoRedo.push(moveCommand);
    }

    this._dragState = undefined;
    this._dragStartPos = undefined;
  }

  /**
   * Delete the currently selected states and transitions.
   */
  handleDelete(): void {
    const stateIds = [...this._selectedStateIds];
    const transitionIds = [...this._selectedTransitionIds];

    if (stateIds.length === 0 && transitionIds.length === 0) return;

    const removedStates: FSMState[] = [];
    const removedTransitions: FSMTransition[] = [];
    const fsm = this._fsm;

    for (const sid of stateIds) {
      const s = findStateById(fsm, sid);
      if (s !== undefined) removedStates.push(s);
      const connected = findTransitionsForState(fsm, sid);
      for (const t of connected) {
        if (!removedTransitions.some((rt) => rt.id === t.id)) {
          removedTransitions.push(t);
        }
      }
    }

    for (const tid of transitionIds) {
      const t = fsm.transitions.find((tr) => tr.id === tid);
      if (t !== undefined && !removedTransitions.some((rt) => rt.id === t.id)) {
        removedTransitions.push(t);
      }
    }

    const deleteCommand: EditCommand = {
      description: "Delete FSM items",
      execute(): void {
        for (const s of removedStates) {
          removeState(fsm, s.id);
        }
        for (const t of removedTransitions) {
          removeTransition(fsm, t.id);
        }
      },
      undo(): void {
        for (const s of removedStates) {
          fsm.states.push(s);
        }
        for (const t of removedTransitions) {
          fsm.transitions.push(t);
        }
      },
    };

    this._undoRedo.push(deleteCommand);
    this._selectedStateIds.clear();
    this._selectedTransitionIds.clear();
  }

  clearSelection(): void {
    this._selectedStateIds.clear();
    this._selectedTransitionIds.clear();
  }

  selectState(stateId: string): void {
    this._selectedStateIds.clear();
    this._selectedTransitionIds.clear();
    this._selectedStateIds.add(stateId);
  }

  selectTransition(transitionId: string): void {
    this._selectedStateIds.clear();
    this._selectedTransitionIds.clear();
    this._selectedTransitionIds.add(transitionId);
  }

  private _addStateAt(x: number, y: number): void {
    const fsm = this._fsm;
    const name = `S${fsm.states.length}`;
    const isInitial = fsm.states.length === 0;

    let createdState: FSMState | undefined;

    const command: EditCommand = {
      description: `Add state ${name}`,
      execute(): void {
        if (createdState !== undefined) {
          // Re-add the same state object on redo to preserve its ID
          fsm.states.push(createdState);
        } else {
          createdState = addState(fsm, name, { x, y }, { isInitial });
        }
      },
      undo(): void {
        if (createdState !== undefined) {
          removeState(fsm, createdState.id);
        }
      },
    };

    this._undoRedo.push(command);
  }

  private _handleTransitionClick(x: number, y: number): void {
    const hit = hitTestFSM(this._fsm, x, y);
    if (hit.type !== "state") return;

    if (this._pendingTransitionSource === undefined) {
      this._pendingTransitionSource = hit.state;
    } else {
      const source = this._pendingTransitionSource;
      const target = hit.state;
      const fsm = this._fsm;

      let createdTransition: FSMTransition | undefined;

      const command: EditCommand = {
        description: `Add transition ${source.name} -> ${target.name}`,
        execute(): void {
          createdTransition = addTransition(fsm, source.id, target.id, "");
        },
        undo(): void {
          if (createdTransition !== undefined) {
            removeTransition(fsm, createdTransition.id);
            createdTransition = undefined;
          }
        },
      };

      this._undoRedo.push(command);
      this._pendingTransitionSource = undefined;
    }
  }

  private _handleSelectClick(x: number, y: number): void {
    const hit = hitTestFSM(this._fsm, x, y);
    this._selectedStateIds.clear();
    this._selectedTransitionIds.clear();

    if (hit.type === "state") {
      this._selectedStateIds.add(hit.state.id);
    } else if (hit.type === "transition") {
      this._selectedTransitionIds.add(hit.transition.id);
    }
  }
}
