/**
 * PowerOverlay — optional per-component power dissipation visualization.
 *
 * Two modes:
 *   'labels'  — draws a formatted "47 mW" text label next to each component
 *               that dissipates non-zero power.
 *   'heatmap' — tints each component body with a yellow→orange→red gradient
 *               proportional to its power relative to the circuit maximum.
 *   'off'     — no rendering (zero overhead).
 *
 * Off by default. Toggled via toolbar or View menu.
 *
 * Max-power tracking uses instant expansion / slow contraction smoothing
 * so that visual jitter is avoided when peak power briefly drops.
 */

import type { SimulationCoordinator } from "@/solver/coordinator-types";
import type { RenderContext } from "@/core/renderer-interface";
import type { Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import { formatSI } from "@/editor/si-format";
import { interpolateColor } from "@/editor/color-interpolation";

// ---------------------------------------------------------------------------
// Gradient color stops for the heatmap (yellow → orange → red)
// ---------------------------------------------------------------------------

const COLOR_YELLOW = "#ffff00";
const COLOR_ORANGE = "#ff8800";
const COLOR_RED = "#ff0000";

// Smoothing factor for contraction (instant expansion, slow contraction).
const SMOOTHING = 0.05;

// ---------------------------------------------------------------------------
// PowerOverlay
// ---------------------------------------------------------------------------

export class PowerOverlay {
  private readonly _coordinator: SimulationCoordinator;

  private _mode: "off" | "labels" | "heatmap" = "off";

  /** Smoothed maximum power across all elements (for heatmap normalization). */
  private _smoothedMax: number = 0;

  constructor(coordinator: SimulationCoordinator) {
    this._coordinator = coordinator;
  }

  /** Set the display mode. */
  setMode(mode: "off" | "labels" | "heatmap"): void {
    this._mode = mode;
  }

  /** Current display mode. */
  get mode(): "off" | "labels" | "heatmap" {
    return this._mode;
  }

  /**
   * Render power information for all components in the circuit.
   *
   * Must be called once per render frame after the engine has stepped.
   */
  render(ctx: RenderContext, circuit: Circuit): void {
    if (this._mode === "off") return;

    // Gather element powers and update the smoothed maximum.
    const elementPowers = this._gatherPowers(circuit.elements);
    this._updateSmoothedMax(elementPowers);

    if (this._mode === "labels") {
      this._renderLabels(ctx, circuit.elements, elementPowers);
    } else {
      this._renderHeatmap(ctx, circuit.elements, elementPowers);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Gather power for each circuit element, indexed parallel to the elements array. */
  private _gatherPowers(elements: readonly CircuitElement[]): Float64Array {
    const ctx = this._coordinator.getCurrentResolverContext();
    const powers = new Float64Array(elements.length);
    if (ctx === null) return powers;

    const elementIndexMap = new Map<CircuitElement, number>();
    for (const [idx, el] of ctx.elementToCircuitElement) {
      elementIndexMap.set(el, idx);
    }

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      const eIdx = elementIndexMap.get(el);
      if (eIdx !== undefined) {
        powers[i] = Math.abs(this._coordinator.readElementPower(eIdx) ?? 0);
      }
    }
    return powers;
  }

  /**
   * Update _smoothedMax with instant expansion and slow (SMOOTHING) contraction.
   */
  private _updateSmoothedMax(powers: Float64Array): void {
    let rawMax = 0;
    for (let i = 0; i < powers.length; i++) {
      if (powers[i]! > rawMax) rawMax = powers[i]!;
    }

    if (rawMax > this._smoothedMax) {
      // Instant expansion.
      this._smoothedMax = rawMax;
    } else {
      // Slow contraction.
      this._smoothedMax = (1 - SMOOTHING) * this._smoothedMax + SMOOTHING * rawMax;
    }
  }

  /** Draw text labels showing power next to each component. */
  private _renderLabels(
    ctx: RenderContext,
    elements: readonly CircuitElement[],
    powers: Float64Array,
  ): void {
    for (let i = 0; i < elements.length; i++) {
      const power = powers[i]!;
      if (power === 0) continue; // Skip zero-power components.

      const el = elements[i]!;
      const bb = el.getBoundingBox();
      const cx = bb.x + bb.width / 2;
      const cy = bb.y - 4; // Offset above the bounding box.

      const label = formatSI(power, "W");
      ctx.drawText(label, cx, cy, { horizontal: "center", vertical: "bottom" });
    }
  }

  /** Draw semi-transparent heat-map rectangles over each component body. */
  private _renderHeatmap(
    ctx: RenderContext,
    elements: readonly CircuitElement[],
    powers: Float64Array,
  ): void {
    const maxPower = this._smoothedMax;

    for (let i = 0; i < elements.length; i++) {
      const power = powers[i]!;
      const el = elements[i]!;
      const bb = el.getBoundingBox();

      // Normalize power to [0, 1].
      const t = maxPower > 0 ? Math.min(1, power / maxPower) : 0;

      // Two-segment gradient: [0, 0.5] → yellow→orange; [0.5, 1] → orange→red.
      let color: string;
      if (t <= 0.5) {
        color = interpolateColor(COLOR_YELLOW, COLOR_ORANGE, t * 2);
      } else {
        color = interpolateColor(COLOR_ORANGE, COLOR_RED, (t - 0.5) * 2);
      }

      if (ctx.setRawColor !== undefined) {
        ctx.setRawColor(color);
      }
      ctx.drawRect(bb.x, bb.y, bb.width, bb.height, true);
    }
  }
}
