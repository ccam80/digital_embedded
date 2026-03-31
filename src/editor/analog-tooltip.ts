/**
 * AnalogTooltip — hover tooltips showing instantaneous electrical values.
 *
 * Wire/pin hover shows voltage. Component body hover shows current and power.
 * The tooltip appears after a 200ms delay and follows the mouse.
 *
 * Renders as a positioned `<div>` overlay above the canvas element
 * (absolute positioning within the canvas container). Flip rule: if the
 * tooltip would extend beyond the canvas right edge by > 10px, position it
 * to the left of the cursor; similarly for the bottom edge.
 */

import type { SimulationCoordinator } from "@/solver/coordinator-types";
import type { RenderContext } from "@/core/renderer-interface";
import type { HitResult } from "@/editor/hit-test";
import type { CircuitElement } from "@/core/element";
import { formatSI } from "@/editor/si-format";
import type { WireCurrentResolver } from "@/editor/wire-current-resolver";

// ---------------------------------------------------------------------------
// AnalogTooltip
// ---------------------------------------------------------------------------

export class AnalogTooltip {
  private readonly _coordinator: SimulationCoordinator;

  /**
   * Cached inverted map: CircuitElement → element index.
   * Rebuilt lazily when the resolver context reference changes.
   */
  private _elementIndexCache: Map<CircuitElement, number> | null = null;
  /** The resolver context whose entries populate `_elementIndexCache`. */
  private _cachedResolverCtx: ReturnType<SimulationCoordinator["getCurrentResolverContext"]> = null;

  /** The pending or active tooltip text (empty = not visible). */
  private _text: string = "";

  /** Whether the tooltip is currently visible (delay elapsed). */
  private _visible: boolean = false;

  /** Current mouse position in canvas client pixels. */
  private _mouseX: number = 0;
  private _mouseY: number = 0;

  /** The canvas element used for edge-flip bounds checking. */
  private _canvas: HTMLCanvasElement | null = null;

  /** The DOM tooltip element. */
  private _div: HTMLDivElement | null = null;

  /** Timer handle for the 200ms hover delay. */
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    coordinator: SimulationCoordinator,
    _resolver: WireCurrentResolver,
  ) {
    this._coordinator = coordinator;
  }

  /**
   * Attach to a canvas container so the tooltip div can be positioned
   * absolutely within it. Call once after construction.
   */
  attachToCanvas(canvas: HTMLCanvasElement): void {
    this._canvas = canvas;

    const container = canvas.parentElement;
    if (container === null) return;

    const div = document.createElement("div");
    div.style.cssText = [
      "position: absolute",
      "pointer-events: none",
      "display: none",
      "background: rgba(20,20,20,0.85)",
      "color: #ffffff",
      "font-family: monospace",
      "font-size: 12px",
      "padding: 4px 8px",
      "border-radius: 4px",
      "box-shadow: 0 2px 6px rgba(0,0,0,0.5)",
      "white-space: nowrap",
      "z-index: 9999",
    ].join(";");
    container.style.position = "relative";
    container.appendChild(div);
    this._div = div;
  }

  /**
   * Called each time the mouse moves over the circuit canvas.
   *
   * @param x         Mouse X in canvas client pixels.
   * @param y         Mouse Y in canvas client pixels.
   * @param hitTarget The current hit-test result (null = nothing hit).
   */
  onMouseMove(x: number, y: number, hitTarget: HitResult | null): void {
    this._mouseX = x;
    this._mouseY = y;

    const text = this._textForHit(hitTarget);

    if (text === "") {
      // Nothing hoverable — cancel timer and hide.
      this._cancelTimer();
      this._hide();
      return;
    }

    if (text === this._text && this._visible) {
      // Same target, already visible — just update position.
      this._updateDivPosition();
      return;
    }

    // New target — restart 200ms delay.
    this._text = text;
    this._hide();
    this._cancelTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      this._visible = true;
      this._showDiv();
    }, 200);
  }

  /**
   * Called when the mouse leaves the circuit area entirely.
   * The tooltip disappears immediately.
   */
  onMouseLeave(): void {
    this._cancelTimer();
    this._hide();
  }

  /**
   * Draw method — this tooltip is DOM-based, not canvas-based.
   * The `render` method exists to satisfy the interface but the tooltip is
   * managed via the DOM overlay. Canvas-based callers may call this no-op.
   */
  render(_ctx: RenderContext): void {
    // Tooltip is rendered as a DOM overlay, not via canvas.
  }

  /** Remove the tooltip div and cancel any pending timer. */
  dispose(): void {
    this._cancelTimer();
    if (this._div !== null && this._div.parentElement !== null) {
      this._div.parentElement.removeChild(this._div);
    }
    this._div = null;
    this._canvas = null;
    this._visible = false;
    this._text = "";
  }

  // ---------------------------------------------------------------------------
  // State accessors (for tests)
  // ---------------------------------------------------------------------------

  /** Whether the tooltip is currently visible. */
  get visible(): boolean {
    return this._visible;
  }

  /** The text content of the tooltip (empty when not visible or no target). */
  get text(): string {
    return this._text;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Compute the tooltip text for a given hit result. Returns "" if none. */
  private _textForHit(hit: HitResult | null): string {
    if (hit === null || hit.type === "none") return "";

    if (hit.type === "wire") {
      const addr = this._coordinator.compiled.wireSignalMap.get(hit.wire);
      if (addr === undefined || addr.domain !== "analog") return "";
      const sv = this._coordinator.readSignal(addr);
      if (sv.type !== "analog") return "";
      return formatSI(sv.voltage, "V");
    }

    if (hit.type === "pin") {
      const pinVoltages = this._coordinator.getPinVoltages(hit.element);
      if (pinVoltages === null) return "";
      const voltage = pinVoltages.get(hit.pin.label);
      if (voltage === undefined) return "";
      return formatSI(voltage, "V");
    }

    if (hit.type === "element") {
      return this._textForElement(hit.element);
    }

    return "";
  }

  private _textForElement(element: CircuitElement): string {
    const ctx = this._coordinator.getCurrentResolverContext();
    if (ctx === null) return "";

    // Rebuild the inverted cache when the resolver context reference changes.
    if (ctx !== this._cachedResolverCtx) {
      this._cachedResolverCtx = ctx;
      const cache = new Map<CircuitElement, number>();
      for (const [idx, el] of ctx.elementToCircuitElement) {
        cache.set(el, idx);
      }
      this._elementIndexCache = cache;
    }

    const eIdx = this._elementIndexCache!.get(element) ?? -1;
    if (eIdx === -1) return "";
    const current = this._coordinator.readElementCurrent(eIdx);
    const power = this._coordinator.readElementPower(eIdx);
    if (current === null || power === null) return "";
    return `${formatSI(Math.abs(current), "A")}, ${formatSI(Math.abs(power), "W")}`;
  }

  private _hide(): void {
    this._visible = false;
    if (this._div !== null) {
      this._div.style.display = "none";
    }
  }

  private _showDiv(): void {
    if (this._div === null) return;
    this._div.textContent = this._text;
    this._div.style.display = "block";
    this._updateDivPosition();
  }

  private _updateDivPosition(): void {
    if (this._div === null || !this._visible) return;

    const OFFSET_X = 12;
    const OFFSET_Y = 12;
    const FLIP_MARGIN = 10;

    const divW = this._div.offsetWidth;
    const divH = this._div.offsetHeight;

    const canvasW = this._canvas?.width ?? 0;
    const canvasH = this._canvas?.height ?? 0;

    let left = this._mouseX + OFFSET_X;
    let top = this._mouseY + OFFSET_Y;

    if (canvasW > 0 && left + divW > canvasW - FLIP_MARGIN) {
      left = this._mouseX - OFFSET_X - divW;
    }
    if (canvasH > 0 && top + divH > canvasH - FLIP_MARGIN) {
      top = this._mouseY - OFFSET_Y - divH;
    }

    this._div.style.left = `${left}px`;
    this._div.style.top = `${top}px`;
  }

  private _cancelTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
