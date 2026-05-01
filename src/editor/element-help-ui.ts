/**
 * Element Help UI- DOM rendering for the element help dialog.
 *
 * Renders a HelpContent record as a modal overlay. The modal is appended to
 * document.body and removed when the user dismisses it.
 *
 * This module contains all browser-DOM code for the help dialog and must not
 * be imported by headless or core modules.
 */

import type { HelpContent, PinInfo, PropInfo } from "./element-help.js";

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === "string") {
      element.appendChild(document.createTextNode(child));
    } else {
      element.appendChild(child);
    }
  }
  return element;
}

function buildPinTable(pins: readonly PinInfo[]): HTMLTableElement {
  const table = el("table", { class: "help-pin-table" });

  const thead = el(
    "thead",
    {},
    el("tr", {}, el("th", {}, "Pin"), el("th", {}, "Direction"), el("th", {}, "Width")),
  );
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const pin of pins) {
    const labelText = pin.isNegated ? `\u00AC${pin.label}` : pin.label;
    const clockSuffix = pin.isClock ? " \u23F0" : "";
    tbody.appendChild(
      el(
        "tr",
        {},
        el("td", {}, `${labelText}${clockSuffix}`),
        el("td", {}, pin.direction),
        el("td", {}, String(pin.bitWidth)),
      ),
    );
  }
  table.appendChild(tbody);

  return table;
}

function buildPropertyTable(props: readonly PropInfo[]): HTMLTableElement {
  const table = el("table", { class: "help-property-table" });

  const thead = el(
    "thead",
    {},
    el(
      "tr",
      {},
      el("th", {}, "Property"),
      el("th", {}, "Type"),
      el("th", {}, "Default"),
      el("th", {}, "Description"),
    ),
  );
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const prop of props) {
    tbody.appendChild(
      el(
        "tr",
        {},
        el("td", {}, prop.label),
        el("td", {}, prop.type),
        el("td", {}, prop.defaultValue),
        el("td", {}, prop.description),
      ),
    );
  }
  table.appendChild(tbody);

  return table;
}

// ---------------------------------------------------------------------------
// HelpDialog- the modal overlay
// ---------------------------------------------------------------------------

/**
 * Programmatic handle for an open help dialog.
 * Call close() to dismiss it.
 */
export interface HelpDialog {
  /** Remove the modal from the DOM. */
  close(): void;
}

/**
 * Render a HelpContent record as a modal dialog appended to document.body.
 *
 * The dialog is dismissed when the user clicks the close button, clicks the
 * backdrop, or presses Escape.
 *
 * @returns A HelpDialog handle with a close() method.
 */
export function showHelpDialog(content: HelpContent): HelpDialog {
  const backdrop = el("div", { class: "help-backdrop" });
  backdrop.style.cssText = [
    "position:fixed",
    "inset:0",
    "background:rgba(0,0,0,0.5)",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "z-index:9999",
  ].join(";");

  const dialog = el("div", { class: "help-dialog", role: "dialog", "aria-modal": "true" });
  dialog.style.cssText = [
    "background:#fff",
    "border-radius:4px",
    "padding:1.5rem",
    "max-width:600px",
    "width:90%",
    "max-height:80vh",
    "overflow-y:auto",
    "position:relative",
  ].join(";");

  const closeBtn = el("button", { class: "help-close", "aria-label": "Close help" }, "\u00D7");
  closeBtn.style.cssText = [
    "position:absolute",
    "top:0.5rem",
    "right:0.75rem",
    "background:none",
    "border:none",
    "font-size:1.5rem",
    "cursor:pointer",
  ].join(";");

  const title = el("h2", { class: "help-title" }, content.title);

  const descSection = el("section", { class: "help-description" });
  descSection.appendChild(el("h3", {}, "Description"));
  descSection.appendChild(el("p", {}, content.description));

  const pinsSection = el("section", { class: "help-pins" });
  pinsSection.appendChild(el("h3", {}, "Pins"));
  if (content.pinTable.length > 0) {
    pinsSection.appendChild(buildPinTable(content.pinTable));
  } else {
    pinsSection.appendChild(el("p", {}, "No pins."));
  }

  const propsSection = el("section", { class: "help-properties" });
  propsSection.appendChild(el("h3", {}, "Properties"));
  if (content.propertyTable.length > 0) {
    propsSection.appendChild(buildPropertyTable(content.propertyTable));
  } else {
    propsSection.appendChild(el("p", {}, "No configurable properties."));
  }

  const helpSection = el("section", { class: "help-text" });
  helpSection.appendChild(el("h3", {}, "Notes"));
  helpSection.appendChild(el("p", {}, content.description));

  dialog.append(closeBtn, title, descSection, pinsSection, propsSection, helpSection);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const handle: HelpDialog = {
    close(): void {
      backdrop.remove();
      document.removeEventListener("keydown", onKeydown);
    },
  };

  function onKeydown(evt: KeyboardEvent): void {
    if (evt.key === "Escape") {
      handle.close();
    }
  }

  closeBtn.addEventListener("click", () => handle.close());
  backdrop.addEventListener("click", (evt) => {
    if (evt.target === backdrop) {
      handle.close();
    }
  });
  document.addEventListener("keydown", onKeydown);

  return handle;
}
