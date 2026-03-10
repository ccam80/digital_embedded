/**
 * WireRenderer — draws wire segments, junction dots, and bus annotations.
 *
 * Consumes the engine-agnostic RenderContext and the optional WireSignalAccess
 * bridge. When no engine is connected every wire is drawn in the neutral WIRE
 * colour. When an engine is connected colours reflect the live signal state.
 */

import type { RenderContext } from "@/core/renderer-interface";
import type { Wire } from "@/core/circuit";
import type { WireSignalAccess } from "./wire-signal-access";

/** Radius (in grid units) of a junction dot. */
const JUNCTION_RADIUS = 0.15;

/** Line width for single-bit wires. */
const WIRE_WIDTH_SINGLE = 1;

/** Line width for bus wires (width > 1). */
const WIRE_WIDTH_BUS = 3;

export class WireRenderer {
  /**
   * Draw all wire segments.
   *
   * For each wire the colour is determined from the signal state when a
   * WireSignalAccess is provided. Bus wires (width > 1) are drawn thicker.
   * Selected wires receive a SELECTION colour overlay drawn after the signal
   * colour so they remain visible.
   */
  render(
    ctx: RenderContext,
    wires: readonly Wire[],
    selection: ReadonlySet<Wire>,
    signalAccess?: WireSignalAccess,
  ): void {
    for (const wire of wires) {
      const value = signalAccess?.getWireValue(wire);
      const isBus = (value !== undefined && value.width > 1) || wire.bitWidth > 1;
      const lineWidth = isBus ? WIRE_WIDTH_BUS : WIRE_WIDTH_SINGLE;

      ctx.save();
      ctx.setLineWidth(lineWidth);

      if (selection.has(wire)) {
        ctx.setColor("SELECTION");
      } else {
        ctx.setColor(this._colorForValue(value));
      }

      ctx.drawLine(wire.start.x, wire.start.y, wire.end.x, wire.end.y);
      ctx.restore();
    }
  }

  /**
   * Draw filled junction dots at every point where three or more wire
   * endpoints coincide. A two-wire pass-through does not get a dot.
   */
  renderJunctionDots(ctx: RenderContext, wires: readonly Wire[]): void {
    const counts = new Map<string, number>();

    for (const wire of wires) {
      const startKey = this._pointKey(wire.start.x, wire.start.y);
      const endKey = this._pointKey(wire.end.x, wire.end.y);
      counts.set(startKey, (counts.get(startKey) ?? 0) + 1);
      counts.set(endKey, (counts.get(endKey) ?? 0) + 1);
    }

    ctx.save();
    ctx.setColor("WIRE");

    for (const [key, count] of counts) {
      if (count >= 3) {
        const [x, y] = this._parsePointKey(key);
        ctx.drawCircle(x, y, JUNCTION_RADIUS, true);
      }
    }

    ctx.restore();
  }

  /**
   * Draw bus width markers (slash + number) on wires with bitWidth > 1.
   * The marker is placed on the wire itself, 0.5 grid units from the start
   * endpoint, so it overlays the wire regardless of routing.
   */
  renderBusWidthMarkers(ctx: RenderContext, wires: readonly Wire[]): void {
    ctx.save();

    for (const wire of wires) {
      if (wire.bitWidth <= 1) continue;

      const dx = wire.end.x - wire.start.x;
      const dy = wire.end.y - wire.start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.1) continue;

      const t = Math.min(0.5 / len, 0.5);
      const mx = wire.start.x + dx * t;
      const my = wire.start.y + dy * t;

      // Normal perpendicular to wire direction
      const nx = -dy / len;
      const ny = dx / len;
      const slashSize = 0.2;

      ctx.setColor("COMPONENT");
      ctx.setLineWidth(1);
      ctx.drawLine(
        mx - nx * slashSize + ny * slashSize * 0.75,
        my - ny * slashSize - nx * slashSize * 0.75,
        mx + nx * slashSize - ny * slashSize * 0.75,
        my + ny * slashSize + nx * slashSize * 0.75,
      );

      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.4 });
      ctx.drawText(
        String(wire.bitWidth),
        mx + nx * slashSize + 0.05,
        my + ny * slashSize - 0.15,
        { horizontal: "left", vertical: "bottom" },
      );
    }

    ctx.restore();
  }

  /**
   * Draw value labels at the midpoint of bus wires when an engine is
   * connected and reporting active signal values.
   */
  renderBusAnnotations(
    ctx: RenderContext,
    wires: readonly Wire[],
    signalAccess: WireSignalAccess,
  ): void {
    ctx.save();
    ctx.setColor("TEXT");

    for (const wire of wires) {
      const value = signalAccess.getWireValue(wire);
      if (value === undefined || value.width <= 1) continue;

      const midX = (wire.start.x + wire.end.x) / 2;
      const midY = (wire.start.y + wire.end.y) / 2;
      const label = `0x${value.raw.toString(16)}`;
      ctx.drawText(label, midX, midY, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _colorForValue(
    value: { raw: number; width: number } | undefined,
  ): "WIRE" | "WIRE_HIGH" | "WIRE_LOW" | "WIRE_Z" | "WIRE_UNDEFINED" {
    if (value === undefined) return "WIRE";
    // Mask raw value to the signal's bit width — execute functions may store
    // full 32-bit results (e.g. ~0 >>> 0 = 0xFFFFFFFF for a 1-bit NOT output).
    const mask = value.width >= 32 ? 0xFFFFFFFF : (1 << value.width) - 1;
    const masked = (value.raw & mask) >>> 0;
    if (value.width === 1) {
      if (masked === 1) return "WIRE_HIGH";
      if (masked === 0) return "WIRE_LOW";
    }
    // For bus wires, use neutral color (bus annotations show the value)
    return "WIRE";
  }

  private _pointKey(x: number, y: number): string {
    return `${x},${y}`;
  }

  private _parsePointKey(key: string): [number, number] {
    const parts = key.split(",");
    return [Number(parts[0]), Number(parts[1])];
  }
}
