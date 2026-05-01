/**
 * ShortcutManager- keyboard shortcut registry and dispatch.
 *
 * Supports configurable bindings. Default bindings match Digital's UI.
 * handleKeyDown() dispatches the matching action and returns true if handled.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Modifier = "ctrl" | "shift" | "alt" | "meta";

export interface ShortcutBinding {
  /** The key string as returned by KeyboardEvent.key (case-insensitive match). */
  key: string;
  modifiers: Modifier[];
  description: string;
  action: () => void;
}

// ---------------------------------------------------------------------------
// ShortcutManager
// ---------------------------------------------------------------------------

export class ShortcutManager {
  private readonly _bindings: ShortcutBinding[] = [];

  /**
   * Register a shortcut binding.
   *
   * @param key         KeyboardEvent.key value (matched case-insensitively).
   * @param modifiers   Required modifier keys.
   * @param action      Callback invoked when the shortcut fires.
   * @param description Human-readable description for settings display.
   */
  register(
    key: string,
    modifiers: Modifier[],
    action: () => void,
    description: string,
  ): void {
    this._bindings.push({ key, modifiers, description, action });
  }

  /**
   * Dispatch a keyboard event.
   *
   * Returns true if a registered binding matched and was invoked.
   * Returns false if no binding matched.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    const eventKey = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;
    const alt = event.altKey;

    for (const binding of this._bindings) {
      if (binding.key.toLowerCase() !== eventKey) continue;

      const needsCtrl = binding.modifiers.includes("ctrl") || binding.modifiers.includes("meta");
      const needsShift = binding.modifiers.includes("shift");
      const needsAlt = binding.modifiers.includes("alt");

      if (needsCtrl !== ctrl) continue;
      if (needsShift !== shift) continue;
      if (needsAlt !== alt) continue;

      binding.action();
      return true;
    }

    return false;
  }

  /**
   * Return all registered bindings (for display in settings / help).
   */
  getBindings(): ShortcutBinding[] {
    return [...this._bindings];
  }
}

// ---------------------------------------------------------------------------
// Default bindings factory
// ---------------------------------------------------------------------------

/**
 * Create a ShortcutManager pre-loaded with Digital's default key bindings.
 *
 */
export function createDefaultShortcuts(callbacks: {
  undo?: () => void;
  redo?: () => void;
  copy?: () => void;
  paste?: () => void;
  cut?: () => void;
  duplicate?: () => void;
  selectAll?: () => void;
  escape?: () => void;
  delete?: () => void;
  rotate?: () => void;
  mirror?: () => void;
  search?: () => void;
  presentation?: () => void;
  panMode?: () => void;
  placeVDD?: () => void;
  placeGND?: () => void;
} = {}): ShortcutManager {
  const mgr = new ShortcutManager();

  const noop = () => {};

  mgr.register("Delete", [], callbacks.delete ?? noop, "Delete selected");
  mgr.register("z", ["ctrl"], callbacks.undo ?? noop, "Undo");
  mgr.register("z", ["ctrl", "shift"], callbacks.redo ?? noop, "Redo");
  mgr.register("c", ["ctrl"], callbacks.copy ?? noop, "Copy");
  mgr.register("v", ["ctrl"], callbacks.paste ?? noop, "Paste");
  mgr.register("x", ["ctrl"], callbacks.cut ?? noop, "Cut");
  mgr.register("d", ["ctrl"], callbacks.duplicate ?? noop, "Duplicate");
  mgr.register("a", ["ctrl"], callbacks.selectAll ?? noop, "Select all");
  mgr.register("Escape", [], callbacks.escape ?? noop, "Cancel / deselect");
  mgr.register("r", [], callbacks.rotate ?? noop, "Rotate selection");
  mgr.register("m", [], callbacks.mirror ?? noop, "Mirror selection");
  mgr.register("f", ["ctrl"], callbacks.search ?? noop, "Find / search");
  mgr.register("F4", [], callbacks.presentation ?? noop, "Presentation mode");
  mgr.register(" ", [], callbacks.panMode ?? noop, "Pan mode (hold)");
  mgr.register("v", [], callbacks.placeVDD ?? noop, "Place VDD");
  mgr.register("g", [], callbacks.placeGND ?? noop, "Place GND");

  return mgr;
}
