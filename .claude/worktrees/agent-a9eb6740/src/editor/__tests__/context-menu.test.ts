// @vitest-environment jsdom
/**
 * Tests for the ContextMenu DOM widget.
 *
 * Exercises show/hide, separator rendering, disabled items, and label retrieval.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextMenu, separator } from "../context-menu.js";
import type { MenuAction, MenuItem } from "../context-menu.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function action(label: string, opts?: Partial<MenuAction>): MenuAction {
  const a: MenuAction = { label, action: opts?.action ?? (() => {}), enabled: opts?.enabled ?? true };
  if (opts?.shortcut !== undefined) a.shortcut = opts.shortcut;
  return a;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextMenu", () => {
  let container: HTMLElement;
  let menu: ContextMenu;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    menu = new ContextMenu(container);
  });

  afterEach(() => {
    menu.hide();
    container.remove();
  });

  it("shows and hides", () => {
    expect(menu.isVisible()).toBe(false);

    menu.showItems(100, 200, [action("Rotate")]);
    expect(menu.isVisible()).toBe(true);
    expect(container.querySelector(".ctx-menu")).not.toBeNull();

    menu.hide();
    expect(menu.isVisible()).toBe(false);
    expect(container.querySelector(".ctx-menu")).toBeNull();
  });

  it("returns visible labels", () => {
    menu.showItems(0, 0, [
      action("Rotate", { shortcut: "R" }),
      action("Delete", { shortcut: "Del" }),
    ]);
    expect(menu.getVisibleLabels()).toEqual(["Rotate", "Delete"]);
  });

  it("renders separators", () => {
    const items: MenuItem[] = [
      action("Copy"),
      separator(),
      action("Delete"),
    ];
    menu.showItems(0, 0, items);
    const seps = container.querySelectorAll(".ctx-menu-separator");
    expect(seps.length).toBe(1);
    // Labels should not include separator
    expect(menu.getVisibleLabels()).toEqual(["Copy", "Delete"]);
  });

  it("renders disabled items with correct class", () => {
    menu.showItems(0, 0, [action("Paste", { enabled: false })]);
    const item = container.querySelector(".ctx-menu-item");
    expect(item?.classList.contains("ctx-menu-item--disabled")).toBe(true);
  });

  it("renders shortcut hints", () => {
    menu.showItems(0, 0, [action("Rotate", { shortcut: "R" })]);
    const shortcut = container.querySelector(".ctx-menu-shortcut");
    expect(shortcut?.textContent).toBe("R");
  });

  it("fires action on click", () => {
    let fired = false;
    menu.showItems(0, 0, [action("Go", { action: () => { fired = true; } })]);
    const item = container.querySelector(".ctx-menu-item") as HTMLElement;
    item.click();
    expect(fired).toBe(true);
    // Menu auto-hides after click
    expect(menu.isVisible()).toBe(false);
  });

  it("replaces previous menu on re-show", () => {
    menu.showItems(0, 0, [action("A")]);
    menu.showItems(0, 0, [action("B")]);
    expect(container.querySelectorAll(".ctx-menu").length).toBe(1);
    expect(menu.getVisibleLabels()).toEqual(["B"]);
  });

  it("does not show empty menu", () => {
    menu.showItems(0, 0, []);
    expect(menu.isVisible()).toBe(false);
  });
});
