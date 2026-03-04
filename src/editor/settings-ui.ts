/**
 * Settings dialog DOM rendering.
 *
 * Builds a modal overlay containing form inputs for every application setting.
 * All DOM construction is kept in this file so that settings.ts remains free
 * of browser dependencies and is usable in headless / Node.js contexts.
 */

import { AppSettings, SettingKey } from "./settings.js";

// ---------------------------------------------------------------------------
// SettingsDialog
// ---------------------------------------------------------------------------

/**
 * Modal settings dialog.
 *
 * open() injects the dialog into the document and displays it.
 * close() removes it and calls the optional onClose callback.
 */
export class SettingsDialog {
  private _overlay: HTMLElement | null = null;
  private _settings: AppSettings;
  private _onClose: (() => void) | null;

  constructor(settings: AppSettings, onClose?: () => void) {
    this._settings = settings;
    this._onClose = onClose ?? null;
  }

  open(): void {
    if (this._overlay !== null) return;
    this._overlay = this._build();
    document.body.appendChild(this._overlay);
  }

  close(): void {
    if (this._overlay === null) return;
    document.body.removeChild(this._overlay);
    this._overlay = null;
    if (this._onClose !== null) this._onClose();
  }

  private _build(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog";
    dialog.role = "dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Application Settings");
    dialog.style.cssText =
      "background:#fff;border-radius:6px;padding:24px;min-width:360px;max-width:480px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:16px";

    const title = document.createElement("h2");
    title.textContent = "Settings";
    title.style.cssText = "margin:0;font-size:1.2rem";
    dialog.appendChild(title);

    dialog.appendChild(this._buildGridSizeRow());
    dialog.appendChild(this._buildDefaultDelayRow());
    dialog.appendChild(this._buildColorSchemeRow());
    dialog.appendChild(this._buildSimSpeedRow());
    dialog.appendChild(this._buildDefaultRadixRow());
    dialog.appendChild(this._buildGateShapeRow());
    dialog.appendChild(this._buildSnapToGridRow());
    dialog.appendChild(this._buildButtons());

    overlay.appendChild(dialog);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    return overlay;
  }

  private _row(label: string, input: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:12px";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    lbl.style.cssText = "flex:1;font-size:.9rem";
    row.appendChild(lbl);
    row.appendChild(input);
    return row;
  }

  private _buildGridSizeRow(): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "20";
    input.value = String(this._settings.get(SettingKey.GRID_SIZE));
    input.style.cssText = "width:64px";
    input.addEventListener("change", () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v) && v >= 1) {
        this._settings.set(SettingKey.GRID_SIZE, v);
        this._settings.save();
      }
    });
    return this._row("Grid Size", input);
  }

  private _buildDefaultDelayRow(): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = String(this._settings.get(SettingKey.DEFAULT_DELAY));
    input.style.cssText = "width:64px";
    input.addEventListener("change", () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v) && v >= 0) {
        this._settings.set(SettingKey.DEFAULT_DELAY, v);
        this._settings.save();
      }
    });
    return this._row("Default Gate Delay", input);
  }

  private _buildColorSchemeRow(): HTMLElement {
    const select = document.createElement("select");
    for (const scheme of ["default", "high-contrast", "monochrome"]) {
      const opt = document.createElement("option");
      opt.value = scheme;
      opt.textContent = scheme;
      select.appendChild(opt);
    }
    select.value = this._settings.get(SettingKey.COLOR_SCHEME);
    select.addEventListener("change", () => {
      this._settings.set(SettingKey.COLOR_SCHEME, select.value);
      this._settings.save();
    });
    return this._row("Color Scheme", select);
  }

  private _buildSimSpeedRow(): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "100";
    input.value = String(this._settings.get(SettingKey.SIM_SPEED));
    input.style.cssText = "width:64px";
    input.addEventListener("change", () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v) && v >= 1) {
        this._settings.set(SettingKey.SIM_SPEED, v);
        this._settings.save();
      }
    });
    return this._row("Simulation Speed", input);
  }

  private _buildDefaultRadixRow(): HTMLElement {
    const select = document.createElement("select");
    for (const radix of ["hex", "dec", "bin", "signed"]) {
      const opt = document.createElement("option");
      opt.value = radix;
      opt.textContent = radix;
      select.appendChild(opt);
    }
    select.value = this._settings.get(SettingKey.DEFAULT_RADIX);
    select.addEventListener("change", () => {
      this._settings.set(
        SettingKey.DEFAULT_RADIX,
        select.value as "hex" | "dec" | "bin" | "signed",
      );
      this._settings.save();
    });
    return this._row("Default Display Radix", select);
  }

  private _buildGateShapeRow(): HTMLElement {
    const select = document.createElement("select");
    for (const style of ["ieee", "iec"]) {
      const opt = document.createElement("option");
      opt.value = style;
      opt.textContent = style.toUpperCase();
      select.appendChild(opt);
    }
    select.value = this._settings.get(SettingKey.GATE_SHAPE);
    select.addEventListener("change", () => {
      this._settings.set(
        SettingKey.GATE_SHAPE,
        select.value as "ieee" | "iec",
      );
      this._settings.save();
    });
    return this._row("Gate Shape Style", select);
  }

  private _buildSnapToGridRow(): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this._settings.get(SettingKey.SNAP_TO_GRID);
    input.addEventListener("change", () => {
      this._settings.set(SettingKey.SNAP_TO_GRID, input.checked);
      this._settings.save();
    });
    return this._row("Snap to Grid", input);
  }

  private _buildButtons(): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;gap:8px";

    const close = document.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    row.appendChild(close);

    return row;
  }
}
