/**
 * CurrentFlowAnimator — animated current-flow dots along wire segments.
 *
 * Renders small filled circles (dots) that move along wire segments at
 * speeds proportional to current magnitude. Uses WireCurrentResolver to
 * obtain per-wire currents and directions.
 *
 * Dots move at a uniform **absolute** speed (grid units / second) for a
 * given current magnitude — short stubs and long runs move at the same
 * rate. Each segment stores a single scalar offset (in grid units) rather
 * than per-dot phase arrays. All segments initialise their offset to 0
 * and advance by `|I| × speedScale × dt`, so segments carrying the same
 * current stay in lock-step. At render time dots are placed at
 * `(offset mod spacing)` intervals along the segment, which produces a
 * visually continuous dot stream across wire→component→wire junctions
 * without any explicit path-tracing.
 *
 * Supports two scale modes:
 *   - **linear**: dot speed is directly proportional to current magnitude
 *   - **logarithmic**: dot speed ∝ log(1 + |I|/ref), making small
 *     currents visible alongside large ones
 */

import type { RenderContext } from "@/core/renderer-interface";
import type { Wire, Circuit } from "@/core/circuit";
import type { WireCurrentResolver, ComponentCurrentPath } from "./wire-current-resolver";

/** Dot radius in grid units — slightly wider than wire for visibility. */
const DOT_RADIUS_GRID = 0.08;

/** Spacing between dots along any segment, in grid units. */
const DOT_SPACING_GRID = 1.0;

/** Default speed scale multiplier (grid-units per amp-second). */
const DEFAULT_SPEED_SCALE = 200;

/** Reference current for logarithmic scaling (1 mA). */
const LOG_REFERENCE_CURRENT = 1e-3;

export type CurrentScaleMode = "linear" | "logarithmic";

export class CurrentFlowAnimator {
  private _resolver: WireCurrentResolver;
  private _speedScale: number = DEFAULT_SPEED_SCALE;
  private _scaleMode: CurrentScaleMode = "linear";
  private _enabled: boolean = true;

  /**
   * Per-wire offset in grid units.  Positive = start→end direction.
   * All offsets start at 0 so series-connected segments are in phase.
   */
  private _wireOffsets: Map<Wire, number> = new Map();

  /** Per-component-body offset keyed by pin-position string. */
  private _componentOffsets: Map<string, number> = new Map();

  constructor(resolver: WireCurrentResolver) {
    this._resolver = resolver;
  }

  /**
   * Set the speed scale multiplier.
   * Effective absolute speed = |I| × speedScale  (grid units / second)
   */
  setSpeedScale(scale: number): void {
    this._speedScale = Math.max(0.1, Math.min(100000, scale));
  }

  get speedScale(): number {
    return this._speedScale;
  }

  setScaleMode(mode: CurrentScaleMode): void {
    this._scaleMode = mode;
  }

  get scaleMode(): CurrentScaleMode {
    return this._scaleMode;
  }

  /**
   * Advance all dot offsets based on wire currents.
   *
   * @param dtSeconds - Frame delta time in seconds.
   * @param circuit - The circuit (needed to iterate wires).
   */
  update(dtSeconds: number, circuit: Circuit): void {
    if (!this._enabled) return;

    for (const wire of circuit.wires) {
      const result = this._resolver.getWireCurrent(wire);
      if (result === undefined || result.current === 0) continue;

      // Absolute speed in grid units / frame
      let speed: number;
      if (this._scaleMode === "logarithmic") {
        speed = Math.log1p(result.current / LOG_REFERENCE_CURRENT) * this._speedScale * dtSeconds;
      } else {
        speed = result.current * this._speedScale * dtSeconds;
      }
      speed *= result.flowSign;

      const prev = this._wireOffsets.get(wire) ?? 0;
      this._wireOffsets.set(wire, prev + speed);
    }

    for (const path of this._resolver.getComponentPaths()) {
      if (path.current === 0) continue;

      let speed: number;
      if (this._scaleMode === "logarithmic") {
        speed = Math.log1p(path.current / LOG_REFERENCE_CURRENT) * this._speedScale * dtSeconds;
      } else {
        speed = path.current * this._speedScale * dtSeconds;
      }
      speed *= path.flowSign;

      const key = this._componentPathKey(path);
      const prev = this._componentOffsets.get(key) ?? 0;
      this._componentOffsets.set(key, prev + speed);
    }
  }

  /**
   * Draw current-flow dots on all wire segments and through component bodies.
   */
  render(ctx: RenderContext, circuit: Circuit): void {
    if (!this._enabled) return;

    ctx.save();
    ctx.setColor("CURRENT_DOT");

    // --- wires ---
    for (const wire of circuit.wires) {
      const result = this._resolver.getWireCurrent(wire);
      if (result === undefined) continue;

      const dx = wire.end.x - wire.start.x;
      const dy = wire.end.y - wire.start.y;
      const wireLen = Math.sqrt(dx * dx + dy * dy);
      if (wireLen < 1e-12) continue;

      const offset = this._wireOffsets.get(wire) ?? 0;
      this._renderDotsAlongSegment(ctx, wire.start.x, wire.start.y, dx, dy, wireLen, offset);
    }

    // --- component bodies ---
    for (const path of this._resolver.getComponentPaths()) {
      const dx = path.pin1.x - path.pin0.x;
      const dy = path.pin1.y - path.pin0.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-12) continue;

      const key = this._componentPathKey(path);
      const offset = this._componentOffsets.get(key) ?? 0;
      this._renderDotsAlongSegment(ctx, path.pin0.x, path.pin0.y, dx, dy, len, offset);
    }

    ctx.restore();
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Place dots at absolute DOT_SPACING_GRID intervals along a segment.
   *
   * The first dot is at distance `((offset % spacing) + spacing) % spacing`
   * from the segment start, then every `spacing` until the segment ends.
   * Because all segments sharing the same current share the same offset
   * advancement rate (and start at 0), dots are continuous across junctions.
   */
  private _renderDotsAlongSegment(
    ctx: RenderContext,
    startX: number, startY: number,
    dx: number, dy: number,
    segLen: number,
    offset: number,
  ): void {
    // Normalise offset into [0, spacing)
    const first = ((offset % DOT_SPACING_GRID) + DOT_SPACING_GRID) % DOT_SPACING_GRID;

    const ux = dx / segLen;
    const uy = dy / segLen;

    for (let d = first; d < segLen; d += DOT_SPACING_GRID) {
      const x = startX + ux * d;
      const y = startY + uy * d;
      ctx.drawCircle(x, y, DOT_RADIUS_GRID, true);
    }
  }

  /** Key for component path offset lookup (stable across resolve calls). */
  private _componentPathKey(path: ComponentCurrentPath): string {
    return `${path.pin0.x},${path.pin0.y}-${path.pin1.x},${path.pin1.y}`;
  }
}
