/**
 * Command pattern for reversible edit operations.
 *
 * Every user action that mutates a circuit produces an EditCommand. Commands
 * are stored on the UndoRedoStack. Undo calls command.undo(); redo calls
 * command.execute() again.
 */

// ---------------------------------------------------------------------------
// EditCommand — the contract every edit operation must satisfy
// ---------------------------------------------------------------------------

/**
 * A single reversible edit operation.
 *
 * execute() applies the operation (also called immediately on push()).
 * undo() reverses it completely.
 * description is shown in the undo/redo menu.
 */
export interface EditCommand {
  execute(): void;
  undo(): void;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// UndoRedoStack
// ---------------------------------------------------------------------------

/**
 * Bounded stack of reversible edit commands.
 *
 * push() executes the command and adds it to the undo stack, clearing the
 * redo stack. undo() reverses the most recent command and moves it to the
 * redo stack. redo() re-executes the most recently undone command.
 */
export class UndoRedoStack {
  private _undoStack: EditCommand[] = [];
  private _redoStack: EditCommand[] = [];
  private _maxDepth = 100;

  /**
   * Optional callback fired after every mutation (push, undo, redo).
   *
   * The editor sets this to `() => propagateWireBitWidths(circuit)` so that
   * wire bit-widths stay consistent after any circuit edit. This is the
   * Option A hook from the architectural refactor spec (Step 5).
   */
  afterMutate: (() => void) | undefined;

  /**
   * Execute the command and push it onto the undo stack.
   * Clears the redo stack.
   */
  push(command: EditCommand): void {
    command.execute();
    this._undoStack.push(command);
    this._redoStack = [];
    this._trimToDepth();
    this.afterMutate?.();
  }

  /**
   * Undo the most recent command.
   * Returns false when there is nothing to undo.
   */
  undo(): boolean {
    const command = this._undoStack.pop();
    if (command === undefined) {
      return false;
    }
    command.undo();
    this._redoStack.push(command);
    this.afterMutate?.();
    return true;
  }

  /**
   * Redo the most recently undone command.
   * Returns false when there is nothing to redo.
   */
  redo(): boolean {
    const command = this._redoStack.pop();
    if (command === undefined) {
      return false;
    }
    command.execute();
    this._undoStack.push(command);
    this.afterMutate?.();
    return true;
  }

  canUndo(): boolean {
    return this._undoStack.length > 0;
  }

  canRedo(): boolean {
    return this._redoStack.length > 0;
  }

  /** Reset both stacks. */
  clear(): void {
    this._undoStack = [];
    this._redoStack = [];
  }

  /**
   * Set the maximum number of commands retained in the undo stack.
   * Trims the oldest entries if the stack already exceeds the new depth.
   */
  setMaxDepth(depth: number): void {
    this._maxDepth = depth;
    this._trimToDepth();
  }

  private _trimToDepth(): void {
    if (this._undoStack.length > this._maxDepth) {
      this._undoStack.splice(0, this._undoStack.length - this._maxDepth);
    }
  }
}
