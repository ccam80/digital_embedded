/**
 * ContextMenu — right-click context menu for the circuit editor.
 *
 * show() renders a menu at a screen position with the given actions.
 * Factory functions build relevant actions for element, wire, and canvas targets.
 */

import type { Point } from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// MenuItem — actions and separators
// ---------------------------------------------------------------------------

export interface MenuAction {
  kind?: "action";
  label: string;
  shortcut?: string;
  action: () => void;
  enabled: boolean;
}

export interface MenuSeparator {
  kind: "separator";
}

export type MenuItem = MenuAction | MenuSeparator;

export function separator(): MenuSeparator {
  return { kind: "separator" };
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
  private _dismissHandler: ((e: Event) => void) | null = null;

  constructor(container: HTMLElement) {
    this._container = container;
  }

  /**
   * Display a context menu at the given screen position with the given items.
   * Any previously shown menu is hidden first.
   */
  showItems(x: number, y: number, items: MenuItem[]): void {
    this.hide();
    if (items.length === 0) return;

    const menu = this._buildMenu(items);
    menu.style.position = "fixed";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    this._container.appendChild(menu);
    this._menuEl = menu;

    // Clamp to viewport edges after the element has a layout size.
    requestAnimationFrame(() => {
      if (!this._menuEl) return;
      const rect = this._menuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        this._menuEl.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
      }
      if (rect.bottom > window.innerHeight) {
        this._menuEl.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
      }
    });

    // Dismiss on next pointer-down outside the menu, or Escape.
    const dismiss = (ev: Event) => {
      if (ev instanceof KeyboardEvent) {
        if (ev.key === "Escape") this.hide();
        return;
      }
      if (this._menuEl && !this._menuEl.contains(ev.target as Node)) {
        this.hide();
      }
    };
    this._dismissHandler = dismiss;
    setTimeout(() => {
      document.addEventListener("pointerdown", dismiss);
      document.addEventListener("keydown", dismiss);
    }, 0);
  }

  /** Legacy overload kept for any existing callers. */
  show(position: Point, _target: unknown, actions: MenuAction[]): void {
    this.showItems(position.x, position.y, actions);
  }

  /**
   * Dismiss the currently visible menu, if any.
   */
  hide(): void {
    if (this._menuEl !== null) {
      this._menuEl.remove();
      this._menuEl = null;
    }
    if (this._dismissHandler !== null) {
      document.removeEventListener("pointerdown", this._dismissHandler);
      document.removeEventListener("keydown", this._dismissHandler);
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
    return Array.from(items).map(
      (el) => el.querySelector(".ctx-menu-label")?.textContent ?? "",
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _buildMenu(items: MenuItem[]): HTMLElement {
    const menu = document.createElement("ul");
    menu.className = "ctx-menu";

    for (const item of items) {
      if (item.kind === "separator") {
        const sep = document.createElement("li");
        sep.className = "ctx-menu-separator";
        menu.appendChild(sep);
        continue;
      }

      const action = item as MenuAction;
      const li = document.createElement("li");
      li.className = "ctx-menu-item";
      if (!action.enabled) {
        li.classList.add("ctx-menu-item--disabled");
      }

      const labelSpan = document.createElement("span");
      labelSpan.className = "ctx-menu-label";
      labelSpan.textContent = action.label;
      li.appendChild(labelSpan);

      if (action.shortcut !== undefined) {
        const shortcutSpan = document.createElement("span");
        shortcutSpan.className = "ctx-menu-shortcut";
        shortcutSpan.textContent = action.shortcut;
        li.appendChild(shortcutSpan);
      }

      if (action.enabled) {
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          action.action();
          this.hide();
        });
      }

      menu.appendChild(li);
    }

    return menu;
  }
}
