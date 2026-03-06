/**
 * ContextMenu — right-click context menu for the circuit editor.
 *
 * show() renders a menu at a screen position with the given actions.
 * Factory functions build relevant actions for element, wire, and canvas targets.
 */

import type { Point } from "@/core/renderer-interface";
import type { CircuitElement } from "@/core/element";
import type { Wire } from "@/core/circuit";
import type { HitResult } from "./hit-test.js";

// ---------------------------------------------------------------------------
// MenuAction
// ---------------------------------------------------------------------------

export interface MenuAction {
  label: string;
  shortcut?: string;
  action: () => void;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Action factory functions
// ---------------------------------------------------------------------------

/**
 * Build a context menu action list for a selected element.
 */
export function buildMenuForElement(
  _element: CircuitElement,
  callbacks: {
    rotate?: () => void;
    mirror?: () => void;
    delete?: () => void;
    copy?: () => void;
    properties?: () => void;
    help?: () => void;
  } = {},
): MenuAction[] {
  return [
    {
      label: "Rotate",
      shortcut: "R",
      action: callbacks.rotate ?? (() => {}),
      enabled: true,
    },
    {
      label: "Mirror",
      shortcut: "M",
      action: callbacks.mirror ?? (() => {}),
      enabled: true,
    },
    {
      label: "Delete",
      shortcut: "Delete",
      action: callbacks.delete ?? (() => {}),
      enabled: true,
    },
    {
      label: "Copy",
      shortcut: "Ctrl+C",
      action: callbacks.copy ?? (() => {}),
      enabled: true,
    },
    {
      label: "Properties",
      action: callbacks.properties ?? (() => {}),
      enabled: true,
    },
    {
      label: "Help",
      action: callbacks.help ?? (() => {}),
      enabled: true,
    },
  ];
}

/**
 * Build a context menu action list for a selected wire.
 */
export function buildMenuForWire(
  _wire: Wire,
  callbacks: {
    delete?: () => void;
    split?: () => void;
  } = {},
): MenuAction[] {
  return [
    {
      label: "Delete",
      shortcut: "Delete",
      action: callbacks.delete ?? (() => {}),
      enabled: true,
    },
    {
      label: "Split",
      action: callbacks.split ?? (() => {}),
      enabled: true,
    },
  ];
}

/**
 * Build a context menu action list for an empty canvas area.
 */
export function buildMenuForCanvas(
  callbacks: {
    paste?: () => void;
    selectAll?: () => void;
  } = {},
): MenuAction[] {
  return [
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      action: callbacks.paste ?? (() => {}),
      enabled: true,
    },
    {
      label: "Select All",
      shortcut: "Ctrl+A",
      action: callbacks.selectAll ?? (() => {}),
      enabled: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// ContextMenu
// ---------------------------------------------------------------------------

/**
 * DOM context menu widget.
 *
 * Renders a floating menu at a screen-space position and dismisses it when
 * the user clicks outside or calls hide().
 */
export class ContextMenu {
  private readonly _container: HTMLElement;
  private _menuEl: HTMLElement | null = null;
  private _dismissHandler: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this._container = container;
  }

  /**
   * Display a context menu at the given screen position with the given actions.
   * Any previously shown menu is hidden first.
   */
  show(position: Point, _target: HitResult, actions: MenuAction[]): void {
    this.hide();

    const menu = this._buildMenu(actions);
    menu.style.left = `${position.x}px`;
    menu.style.top = `${position.y}px`;
    menu.style.position = "absolute";

    this._container.appendChild(menu);
    this._menuEl = menu;

    // Dismiss on next click outside the menu.
    const dismiss = () => {
      this.hide();
    };
    this._dismissHandler = dismiss;
    setTimeout(() => {
      document.addEventListener("click", dismiss, { once: true });
    }, 0);
  }

  /**
   * Dismiss the currently visible menu, if any.
   */
  hide(): void {
    if (this._menuEl !== null) {
      if (this._menuEl.parentNode !== null) {
        this._menuEl.parentNode.removeChild(this._menuEl);
      }
      this._menuEl = null;
    }
    if (this._dismissHandler !== null) {
      document.removeEventListener("click", this._dismissHandler);
      this._dismissHandler = null;
    }
  }

  /**
   * Returns true when a menu is currently visible.
   */
  isVisible(): boolean {
    return this._menuEl !== null;
  }

  /**
   * Returns the action labels of the currently visible menu items, in order.
   */
  getVisibleLabels(): string[] {
    if (this._menuEl === null) return [];
    const items = this._menuEl.querySelectorAll(".ctx-menu-item");
    return Array.from(items).map((el) => (el as HTMLElement).textContent ?? "");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _buildMenu(actions: MenuAction[]): HTMLElement {
    const menu = document.createElement("ul");
    menu.className = "ctx-menu";

    for (const action of actions) {
      const item = document.createElement("li");
      item.className = "ctx-menu-item";
      if (!action.enabled) {
        item.className += " ctx-menu-item--disabled";
      }

      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-menu-label";
      labelSpan.textContent = action.label;
      item.appendChild(labelSpan);

      if (action.shortcut !== undefined) {
        const shortcutSpan = document.createElement("span");
        shortcutSpan.className = "ctx-menu-shortcut";
        shortcutSpan.textContent = action.shortcut;
        item.appendChild(shortcutSpan);
      }

      if (action.enabled) {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          action.action();
          this.hide();
        });
      }

      menu.appendChild(item);
    }

    return menu;
  }
}
