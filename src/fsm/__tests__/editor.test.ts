/**
 * Tests for FSMEditor (task 10.1.2).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { UndoRedoStack } from "@/editor/undo-redo";
import { FSMEditor } from "@/fsm/editor";
import { resetIdCounter } from "@/fsm/model";

describe("FSMEditor", () => {
  let undoRedo: UndoRedoStack;
  let editor: FSMEditor;

  beforeEach(() => {
    resetIdCounter();
    undoRedo = new UndoRedoStack();
    editor = new FSMEditor(undoRedo);
  });

  it("addState", () => {
    editor.setTool("addState");
    editor.handleClick(100, 150);

    expect(editor.fsm.states).toHaveLength(1);
    const state = editor.fsm.states[0]!;
    expect(state.position.x).toBe(100);
    expect(state.position.y).toBe(150);
    expect(state.name).toBe("S0");
    expect(state.isInitial).toBe(true);
  });

  it("addTransition", () => {
    editor.setTool("addState");
    editor.handleClick(100, 100);
    editor.handleClick(300, 100);

    const stateA = editor.fsm.states[0]!;
    const stateB = editor.fsm.states[1]!;

    editor.setTool("addTransition");
    editor.handleClick(stateA.position.x, stateA.position.y);
    editor.handleClick(stateB.position.x, stateB.position.y);

    expect(editor.fsm.transitions).toHaveLength(1);
    const transition = editor.fsm.transitions[0]!;
    expect(transition.sourceStateId).toBe(stateA.id);
    expect(transition.targetStateId).toBe(stateB.id);
  });

  it("selfLoop", () => {
    editor.setTool("addState");
    editor.handleClick(200, 200);

    const state = editor.fsm.states[0]!;

    editor.setTool("addTransition");
    editor.handleClick(state.position.x, state.position.y);
    editor.handleClick(state.position.x, state.position.y);

    expect(editor.fsm.transitions).toHaveLength(1);
    const transition = editor.fsm.transitions[0]!;
    expect(transition.sourceStateId).toBe(state.id);
    expect(transition.targetStateId).toBe(state.id);
  });

  it("deleteState", () => {
    editor.setTool("addState");
    editor.handleClick(100, 100);
    editor.handleClick(300, 100);

    const stateA = editor.fsm.states[0]!;
    const stateB = editor.fsm.states[1]!;

    editor.setTool("addTransition");
    editor.handleClick(stateA.position.x, stateA.position.y);
    editor.handleClick(stateB.position.x, stateB.position.y);

    expect(editor.fsm.transitions).toHaveLength(1);

    editor.setTool("select");
    editor.selectState(stateA.id);
    editor.handleDelete();

    expect(editor.fsm.states).toHaveLength(1);
    expect(editor.fsm.states[0]!.id).toBe(stateB.id);
    expect(editor.fsm.transitions).toHaveLength(0);
  });

  it("moveState", () => {
    editor.setTool("addState");
    editor.handleClick(100, 100);
    editor.handleClick(300, 100);

    const stateA = editor.fsm.states[0]!;
    const stateB = editor.fsm.states[1]!;

    editor.setTool("addTransition");
    editor.handleClick(stateA.position.x, stateA.position.y);
    editor.handleClick(stateB.position.x, stateB.position.y);

    editor.setTool("select");
    editor.handleMouseDown(stateA.position.x, stateA.position.y);
    editor.handleMouseMove(200, 200);
    editor.handleMouseUp(200, 200);

    expect(stateA.position.x).toBe(200);
    expect(stateA.position.y).toBe(200);
  });

  it("undoRedo", () => {
    editor.setTool("addState");
    editor.handleClick(100, 100);

    expect(editor.fsm.states).toHaveLength(1);
    const stateId = editor.fsm.states[0]!.id;

    undoRedo.undo();

    expect(editor.fsm.states).toHaveLength(0);

    undoRedo.redo();

    expect(editor.fsm.states).toHaveLength(1);
    expect(editor.fsm.states[0]!.id).toBe(stateId);
  });
});
