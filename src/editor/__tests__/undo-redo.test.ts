/**
 * Tests for UndoRedoStack (task 2.4.2).
 */

import { describe, it, expect, vi } from "vitest";
import { UndoRedoStack } from "@/editor/undo-redo";
import type { EditCommand } from "@/editor/undo-redo";

// ---------------------------------------------------------------------------
// Helper: build a spy-instrumented EditCommand
// ---------------------------------------------------------------------------

function makeCommand(description: string = "test"): {
  command: EditCommand;
  executeSpy: ReturnType<typeof vi.fn>;
  undoSpy: ReturnType<typeof vi.fn>;
} {
  const executeSpy = vi.fn();
  const undoSpy = vi.fn();
  const command: EditCommand = {
    description,
    execute: executeSpy,
    undo: undoSpy,
  };
  return { command, executeSpy, undoSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UndoRedo", () => {
  it("pushExecutesCommand", () => {
    const stack = new UndoRedoStack();
    const { command, executeSpy } = makeCommand("A");

    stack.push(command);

    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("undoReversesCommand", () => {
    const stack = new UndoRedoStack();
    const { command, undoSpy } = makeCommand("A");

    stack.push(command);
    const result = stack.undo();

    expect(result).toBe(true);
    expect(undoSpy).toHaveBeenCalledTimes(1);
  });

  it("redoReExecutes", () => {
    const stack = new UndoRedoStack();
    const { command, executeSpy } = makeCommand("A");

    stack.push(command);
    stack.undo();
    const result = stack.redo();

    expect(result).toBe(true);
    // execute() was called once by push() and once by redo()
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it("newActionClearsRedoStack", () => {
    const stack = new UndoRedoStack();
    const { command: cmdA } = makeCommand("A");
    const { command: cmdB } = makeCommand("B");

    stack.push(cmdA);
    stack.undo(); // A is on redo stack

    // Pushing B clears the redo stack
    stack.push(cmdB);

    const redoResult = stack.redo();

    // redo returns false because redo stack was cleared
    expect(redoResult).toBe(false);
  });

  it("maxDepthTrimsOldest", () => {
    const stack = new UndoRedoStack();
    stack.setMaxDepth(2);

    const { command: cmd1 } = makeCommand("1");
    const { command: cmd2 } = makeCommand("2");
    const { command: cmd3 } = makeCommand("3");

    stack.push(cmd1);
    stack.push(cmd2);
    stack.push(cmd3); // cmd1 is trimmed- only cmd2 and cmd3 remain

    // Undo cmd3
    expect(stack.undo()).toBe(true);
    // Undo cmd2
    expect(stack.undo()).toBe(true);
    // cmd1 was trimmed, nothing left
    expect(stack.undo()).toBe(false);
  });

  it("canUndoCanRedo", () => {
    const stack = new UndoRedoStack();
    const { command } = makeCommand("A");

    // Initially empty
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);

    stack.push(command);

    // After push: can undo, cannot redo
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);

    stack.undo();

    // After undo: cannot undo, can redo
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(true);

    stack.redo();

    // After redo: can undo again, cannot redo
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);
  });
});
