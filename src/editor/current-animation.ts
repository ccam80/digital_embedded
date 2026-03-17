/**
 * CurrentFlowAnimator — animated current-flow dots along wire segments.
 *
 * Renders small filled circles (dots) that move along wire segments at
 * speeds proportional to current magnitude. Uses WireCurrentResolver to
 * obtain per-wire currents and directions.
 *
 * Dots are represented as phase values in [0, 1) along each wire's length.
 * Advancing phase by `current * speedScale * dt` each frame makes the
 * apparent velocity proportional to current. Dots wrap at 0/1 boundaries.
 *
 * Zero current: dots freeze in place (phase unchanged).
 * Very small current (|I| < minCurrentThreshold): dots are not rendered.
 * Negative current: dots advance in the opposite direction.
 *
 * Dot radius is specified in grid units (0.1) for zoom-independence.
 * Dot spacing is 20 pixels (at default zoom, ~1 grid unit) between dots.
 */

import type { RenderContext } from "@/core/renderer-interface";
import type { Wire, Circuit } from "@/core/circuit";
import type { WireCurrentResolver } from "./wire-current-resolver";

/** Dot radius in grid units. Renders as ~2px at default zoom. */
const DOT_RADIUS_GRID = 0.1;

/** Default spacing between dots along a wire, in grid units. */
const DOT_SPACING_GRID = 1.0;

/** Default minimum current threshold below which dots are invisible. */
const DEFAULT_MIN_CURRENT_THRESHOLD = 1e-6;

/** Default speed scale multiplier. */
const DEFAULT_SPEED_SCALE = 1.0;

/** Minimum allowed speed scale. */
const MIN_SPEED_SCALE = 0.01;

/** Maximum allowed speed scale. */
const MAX_SPEED_SCALE = 100;

export class CurrentFlowAnimator {
  private _resolver: WireCurrentResolver;
  private _speedScale: number = DEFAULT_SPEED_SCALE;
  private _enabled: boolean = true;
  private _minCurrentThreshold: number;

  /**
   * Internal state: dot phase positions per wire.
   * Each entry is an array of phase values in [0, 1), evenly spaced.
   */
  private _dotPhases: Map<Wire, number[]> = new Map();

  /**
   * @param resolver - The WireCurrentResolver providing per-wire currents.
   * @param minCurrentThreshold - Current below which dots are invisible (default 1e-6 A).
   */
  constructor(resolver: WireCurrentResolver, minCurrentThreshold: number = DEFAULT_MIN_CURRENT_THRESHOLD) {
    this._resolver = resolver;
    this._minCurrentThreshold = minCurrentThreshold;
  }

  /**
   * Advance all dot positions proportional to current × speedScale × dt.
   *
   * For a wire with current I and speed scale S, each dot advances by
   * I * S * dtSeconds along the wire's unit-length phase axis.
   * Dots wrap around when they reach 0 or 1.
   * Zero current leaves dots frozen. Negative current reverses direction.
   *
   * @param dtSeconds - Frame delta time in seconds.
   */
  update(dtSeconds: number): void {
    if (!this._enabled) return;

    for (const [wire, phases] of this._dotPhases) {
      const result = this._resolver.getWireCurrent(wire);
      if (result === undefined) continue;

      // Signed current: magnitude × direction sign along wire axis.
      // We use a simplified signed current based on resolver result.
      const I = result.current;
      if (I === 0) continue;

      const advance = I * this._speedScale * dtSeconds;

      for (let i = 0; i < phases.length; i++) {
        let p = phases[i] + advance;
        // Wrap into [0, 1)
        p = p - Math.floor(p);
        phases[i] = p;
      }
    }
  }

  /**
   * Draw current-flow dots on all wire segments with non-zero current.
   *
   * Dots are rendered as filled circles using the CURRENT_DOT theme color.
   * Wires with current below minCurrentThreshold are skipped entirely.
   *
   * @param ctx - The render context.
   * @param circuit - The circuit containing wires.
   */
  render(ctx: RenderContext, circuit: Circuit): void {
    if (!this._enabled) return;

    ctx.save();
    ctx.setColor("CURRENT_DOT");

    for (const wire of circuit.wires) {
      const result = this._resolver.getWireCurrent(wire);
      if (result === undefined) continue;
      if (result.current < this._minCurrentThreshold) continue;

      const phases = this._getOrInitPhases(wire);

      const dx = wire.end.x - wire.start.x;
      const dy = wire.end.y - wire.start.y;
      const wireLen = Math.sqrt(dx * dx + dy * dy);
      if (wireLen < 1e-12) continue;

      for (const phase of phases) {
        const t = phase;
        const x = wire.start.x + dx * t;
        const y = wire.start.y + dy * t;
        ctx.drawCircle(x, y, DOT_RADIUS_GRID, true);
      }
    }

    ctx.restore();
  }

  /**
   * Set the speed scale multiplier.
   * Velocity = current × scale. Clamped to [0.01, 100].
   *
   * @param scale - Linear speed multiplier.
   */
  setSpeedScale(scale: number): void {
    this._speedScale = Math.max(MIN_SPEED_SCALE, Math.min(MAX_SPEED_SCALE, scale));
  }

  /**
   * Enable or disable the animator.
   * When disabled, update() and render() are no-ops.
   *
   * @param enabled - True to activate, false to deactivate.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /** Whether the animator is currently active. */
  get enabled(): boolean {
    return this._enabled;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Return (or initialize) the dot phases for a wire.
   * Dots are evenly spaced by DOT_SPACING_GRID along the wire length.
   */
  private _getOrInitPhases(wire: Wire): number[] {
    let phases = this._dotPhases.get(wire);
    if (phases !== undefined) return phases;

    const dx = wire.end.x - wire.start.x;
    const dy = wire.end.y - wire.start.y;
    const wireLen = Math.sqrt(dx * dx + dy * dy);

    const dotCount = Math.max(1, Math.round(wireLen / DOT_SPACING_GRID));
    phases = [];
    for (let i = 0; i < dotCount; i++) {
      phases.push(i / dotCount);
    }
    this._dotPhases.set(wire, phases);
    return phases;
  }
}
