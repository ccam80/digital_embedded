/**
 * Tests for ShortcutManager.
 *
 * No DOM required- keyboard events are plain objects matching the
 * KeyboardEvent shape that handleKeyDown() reads.
 */

import { describe, it, expect, vi } from "vitest";
import { ShortcutManager, createDefaultShortcuts } from "../shortcuts.js";

// ---------------------------------------------------------------------------
// Helper- build a minimal KeyboardEvent-shaped object
// ---------------------------------------------------------------------------

function makeKeyEvent(
  key: string,
  opts: {
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    metaKey: opts.metaKey ?? false,
  } as KeyboardEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Shortcuts", () => {
  it("ctrlZCallsUndo", () => {
    const undo = vi.fn();
    const mgr = createDefaultShortcuts({ undo });

    const handled = mgr.handleKeyDown(makeKeyEvent("z", { ctrlKey: true }));

    expect(handled).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
  });

  it("rRotatesSelection", () => {
    const rotate = vi.fn();
    const mgr = createDefaultShortcuts({ rotate });

    const handled = mgr.handleKeyDown(makeKeyEvent("r"));

    expect(handled).toBe(true);
    expect(rotate).toHaveBeenCalledOnce();
  });

  it("unknownKeyReturnsFalse", () => {
    const mgr = createDefaultShortcuts();

    const handled = mgr.handleKeyDown(makeKeyEvent("q"));

    expect(handled).toBe(false);
  });

  it("manualRegisterAndDispatch", () => {
    const mgr = new ShortcutManager();
    const action = vi.fn();

    mgr.register("s", ["ctrl"], action, "Save");

    const handled = mgr.handleKeyDown(makeKeyEvent("s", { ctrlKey: true }));
    expect(handled).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });

  it("getBindingsReturnsAll", () => {
    const mgr = createDefaultShortcuts();
    const bindings = mgr.getBindings();

    // Default shortcuts include Ctrl+Z (undo) and R (rotate) and others
    const keys = bindings.map((b) => b.key.toLowerCase());
    expect(keys).toContain("z");
    expect(keys).toContain("r");
    expect(keys).toContain("delete");
  });

  it("modifierMismatchDoesNotFire", () => {
    const undo = vi.fn();
    const mgr = createDefaultShortcuts({ undo });

    // Press Z without Ctrl- should NOT fire undo
    const handled = mgr.handleKeyDown(makeKeyEvent("z"));
    expect(handled).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });
});
