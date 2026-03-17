/**
 * WireRenderer — draws wire segments, junction dots, and bus annotations.
 *
 * Consumes the engine-agnostic RenderContext and the optional WireSignalAccess
 * bridge. When no engine is connected every wire is drawn in the neutral WIRE
 * colour. When an engine is connected colours reflect the live signal state.
 *
 * Analog wires with voltage data use a continuous gradient (red → gray → green)
 * computed from a VoltageRangeTracker. The gradient path calls setRawColor()
 * instead of setColor(), bypassing the ThemeColor lookup entirely.
 */

import type { RenderContext, ColorScheme } from "@/core/renderer-interface";
import { defaultColorScheme } from "@/core/renderer-interface";
import type { Wire } from "@/core/circuit";
import type { WireSignalAccess } from "./wire-signal-access";
import type { VoltageRangeTracker } from "./voltage-range";
import { interpolateColor } from "./color-interpolation";

/** Radius (in grid units) of a junction dot. */
const JUNCTION_RADIUS = 0.15;

/** Line width for single-bit wires. */
const WIRE_WIDTH_SINGLE = 1;

/** Line width for analog wires — thicker than digital to make gradient visible. */
const WIRE_WIDTH_ANALOG = 2;

/** Line width for bus wires (width > 1). */
const WIRE_WIDTH_BUS = 3;

export class WireRenderer {
  private _colorScheme: ColorScheme = defaultColorScheme;
  private _voltageTracker: VoltageRangeTracker | null = null;

  /**
   * Set the active color scheme. Used to resolve voltage gradient endpoint colors.
   *
   * @param scheme - The color scheme to use for theme color resolution.
   */
  setColorScheme(scheme: ColorScheme): void {
    this._colorScheme = scheme;
  }

  /**
   * Set the voltage range tracker used for analog gradient coloring.
   * When null (default), analog wires fall back to the WIRE_ANALOG theme color.
   *
   * @param tracker - Active VoltageRangeTracker, or null to disable gradient.
   */
  setVoltageTracker(tracker: VoltageRangeTracker | null): void {
    this._voltageTracker = tracker;
  }

  /**
   * Draw all wire segments.
   *
   * For each wire the colour is determined from the signal state when a
   * WireSignalAccess is provided. Bus wires (width > 1) are drawn thicker.
   * Analog wires with a voltage tracker use a continuous gradient via setRawColor().
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
      const isAnalog = value !== undefined && "voltage" in value;
      const isBus = !isAnalog && ((value !== undefined && "width" in value && value.width > 1) || wire.bitWidth > 1);

      let lineWidth: number;
      if (isAnalog) {
        lineWidth = WIRE_WIDTH_ANALOG;
      } else if (isBus) {
        lineWidth = WIRE_WIDTH_BUS;
      } else {
        lineWidth = WIRE_WIDTH_SINGLE;
      }

      ctx.save();
      ctx.setLineWidth(lineWidth);

      if (selection.has(wire)) {
        ctx.setColor("SELECTION");
      } else if (isAnalog && this._voltageTracker !== null && ctx.setRawColor !== undefined) {
        const cssColor = this._analogVoltageColor((value as { voltage: number }).voltage);
        ctx.setRawColor(cssColor);
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
      if (value === undefined || "voltage" in value || value.width <= 1) continue;

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

  /**
   * Compute a CSS color string for an analog wire based on its voltage.
   *
   * Queries the VoltageRangeTracker for the normalized voltage (0–1), then
   * interpolates between the theme's endpoint colors:
   *   normalized < 0.5: WIRE_VOLTAGE_NEG → WIRE_VOLTAGE_GND
   *   normalized > 0.5: WIRE_VOLTAGE_GND → WIRE_VOLTAGE_POS
   *   normalized === 0.5: WIRE_VOLTAGE_GND
   */
  private _analogVoltageColor(voltage: number): string {
    const tracker = this._voltageTracker!;
    const normalized = tracker.normalize(voltage);

    const posColor = this._colorScheme.resolve("WIRE_VOLTAGE_POS");
    const negColor = this._colorScheme.resolve("WIRE_VOLTAGE_NEG");
    const gndColor = this._colorScheme.resolve("WIRE_VOLTAGE_GND");

    if (normalized < 0.5) {
      const t = normalized / 0.5;
      return interpolateColor(negColor, gndColor, t);
    } else if (normalized > 0.5) {
      const t = (normalized - 0.5) / 0.5;
      return interpolateColor(gndColor, posColor, t);
    } else {
      return interpolateColor(gndColor, gndColor, 0);
    }
  }

  private _colorForValue(
    value: { raw: number; width: number } | { voltage: number } | undefined,
  ): "WIRE" | "WIRE_HIGH" | "WIRE_LOW" | "WIRE_Z" | "WIRE_UNDEFINED" | "WIRE_ANALOG" {
    if (value === undefined) return "WIRE";
    // Analog wires use a single color (gradient rendering is a future enhancement)
    if ("voltage" in value) return "WIRE_ANALOG";
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
