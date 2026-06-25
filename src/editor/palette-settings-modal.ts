/**
 * Palette settings modal- drag-and-drop reorder + per-component visibility.
 *
 * Replaces the former allowlist checkbox dialog. The modal renders the palette
 * config as an ordered list of groups, each holding an ordered list of
 * components. The user can:
 *   - drag a group handle to reorder groups,
 *   - drag a component handle to reorder components within their group,
 *   - toggle a component's visibility checkbox,
 *   - reset to the factory-default layout.
 *
 * All mutations route through ComponentPalette (which persists), and each
 * mutation calls `onChange` so the sidebar re-renders live. Reordering is
 * constrained to within a single group and group-to-group ordering- components
 * are not dragged across groups (the Common group is a seeded curation, not a
 * drag target).
 */

import { displayNameOf } from "@/core/registry";
import type { ComponentPalette } from "./palette.js";

/** Active drag operation tracked across dragstart/drop. */
type DragState =
  | { kind: "group"; sourceId: string }
  | { kind: "item"; groupId: string; sourceName: string }
  | null;

const HANDLE = "≡"; // ≡ drag handle glyph

export function openPaletteSettingsModal(palette: ComponentPalette, onChange: () => void): void {
  let drag: DragState = null;

  // --- overlay + dialog shell ---
  const overlay = document.createElement("div");
  overlay.className = "test-dialog-overlay";

  const dialog = document.createElement("div");
  dialog.className = "test-dialog";
  dialog.style.width = "440px";

  const header = document.createElement("div");
  header.className = "test-dialog-header";
  const title = document.createElement("span");
  title.textContent = "Palette Components";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.cssText = "background:none;border:none;color:inherit;font-size:18px;cursor:pointer;";
  closeBtn.addEventListener("click", () => overlay.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);

  const hint = document.createElement("div");
  hint.style.cssText = "padding:6px 16px;font-size:11px;opacity:0.7;";
  hint.textContent = "Drag ≡ to reorder. Uncheck to hide from the palette.";

  const body = document.createElement("div");
  body.style.cssText = "flex:1;overflow-y:auto;padding:4px 12px;max-height:60vh;";

  const footer = document.createElement("div");
  footer.className = "test-dialog-footer";
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => {
    palette.resetToDefaults();
    onChange();
    rebuild();
  });
  const doneBtn = document.createElement("button");
  doneBtn.textContent = "Done";
  doneBtn.className = "primary";
  doneBtn.addEventListener("click", () => overlay.remove());
  footer.appendChild(resetBtn);
  footer.appendChild(doneBtn);

  dialog.appendChild(header);
  dialog.appendChild(hint);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // --- body rendering ---
  function rebuild(): void {
    body.innerHTML = "";
    const groups = palette.getConfigGroups();

    groups.forEach((group) => {
      const groupEl = document.createElement("div");
      groupEl.className = "pset-group";
      groupEl.style.cssText = "margin-bottom:8px;border:1px solid var(--panel-border);border-radius:4px;";
      groupEl.dataset["group"] = group.id;

      // Group header row- the handle is the drag source for group reordering.
      const headRow = document.createElement("div");
      headRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--panel-bg);font-weight:600;font-size:12px;border-bottom:1px solid var(--panel-border);";

      const groupHandle = document.createElement("span");
      groupHandle.textContent = HANDLE;
      groupHandle.title = "Drag to reorder group";
      groupHandle.style.cssText = "cursor:grab;opacity:0.6;user-select:none;";
      groupHandle.draggable = true;
      groupHandle.addEventListener("dragstart", (e) => {
        drag = { kind: "group", sourceId: group.id };
        e.dataTransfer?.setData("text/plain", "group");
      });
      headRow.appendChild(groupHandle);

      const groupLabel = document.createElement("span");
      groupLabel.textContent = group.label;
      headRow.appendChild(groupLabel);

      // Group is a drop target for group reordering.
      headRow.addEventListener("dragover", (e) => {
        if (drag?.kind === "group") e.preventDefault();
      });
      headRow.addEventListener("drop", (e) => {
        if (drag?.kind !== "group") return;
        e.preventDefault();
        palette.moveGroup(drag.sourceId, group.id);
        drag = null;
        onChange();
        rebuild();
      });
      groupEl.appendChild(headRow);

      // Items
      const list = document.createElement("div");
      list.style.cssText = "padding:2px 0;";
      group.items.forEach((item) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 8px;font-size:12px;";
        row.dataset["item"] = item.def.name;

        const handle = document.createElement("span");
        handle.textContent = HANDLE;
        handle.title = "Drag to reorder";
        handle.style.cssText = "cursor:grab;opacity:0.5;user-select:none;";
        handle.draggable = true;
        handle.addEventListener("dragstart", (e) => {
          drag = { kind: "item", groupId: group.id, sourceName: item.def.name };
          e.dataTransfer?.setData("text/plain", "item");
          e.stopPropagation();
        });
        row.appendChild(handle);

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = item.visible;
        cb.addEventListener("change", () => {
          palette.setItemVisible(group.id, item.def.name, cb.checked);
          onChange();
        });
        row.appendChild(cb);

        const name = document.createElement("span");
        name.textContent = displayNameOf(item.def);
        name.style.cssText = item.visible ? "" : "opacity:0.5;";
        row.appendChild(name);

        // Item is a drop target for same-group reordering.
        row.addEventListener("dragover", (e) => {
          if (drag?.kind === "item" && drag.groupId === group.id) e.preventDefault();
        });
        row.addEventListener("drop", (e) => {
          if (drag?.kind !== "item" || drag.groupId !== group.id) return;
          e.preventDefault();
          palette.moveItem(group.id, drag.sourceName, item.def.name);
          drag = null;
          onChange();
          rebuild();
        });

        list.appendChild(row);
      });
      groupEl.appendChild(list);

      body.appendChild(groupEl);
    });
  }

  rebuild();
  document.body.appendChild(overlay);
}
