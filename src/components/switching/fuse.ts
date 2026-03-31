/**
 * Fuse — unified digital/analog fuse component.
 *
 * Digital engine: bidirectional switch controlled by the `blown` property.
 *   state[stBase] = blown ? 0 : 1; the bus resolver merges/splits nets.
 *
 * Analog engine: I²t thermal model (AnalogFuseElement). The analog element
 *   writes `_thermalRatio` and `blown` back into the shared PropertyBag
 *   each timestep, so the visual layer shows heat glow and the digital
 *   engine picks up the blown state on the next step.
 *
 * Visual phases:
 *   Cold (ratio < 0.3)     — normal sine wave, component color
 *   Warming (0.3 → 0.9)    — thickening line, color lerps to orange/red
 *   Critical (0.9 → 1.0)   — red, thick, slight vertex jitter
 *   Blown                   — gap in middle, warped endpoints, smoke puff
 *
 * Pins:
 *   Bidirectional: out1, out2
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { createAnalogFuseElement, ANALOG_FUSE_PARAM_DEFS, ANALOG_FUSE_DEFAULTS } from "../passives/analog-fuse.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 1;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FUSE_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out1",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out2",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// Heat color helpers
// ---------------------------------------------------------------------------

/** Lerp between two [r,g,b] triples. */
function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

const COLOR_COLD: [number, number, number] = [100, 100, 100];   // neutral gray (component)
const COLOR_WARM: [number, number, number] = [255, 160, 0];     // orange
const COLOR_HOT: [number, number, number] = [255, 40, 0];       // red
const COLOR_CHARRED: [number, number, number] = [60, 50, 45];   // dark charred brown

/** Map thermalRatio (0→1) to a heat color CSS string. */
function heatColor(ratio: number): string {
  if (ratio < 0.3) return lerpRgb(COLOR_COLD, COLOR_COLD, 0);
  if (ratio < 0.7) {
    const t = (ratio - 0.3) / 0.4;
    return lerpRgb(COLOR_COLD, COLOR_WARM, t);
  }
  const t = (ratio - 0.7) / 0.3;
  return lerpRgb(COLOR_WARM, COLOR_HOT, t);
}

// ---------------------------------------------------------------------------
// Sine wave geometry (shared between intact and blown states)
// ---------------------------------------------------------------------------

const SEGMENTS = 16;
const HS = 6 / 16; // 0.375 — half-height of sine wave

function sinePoints(): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    pts.push({
      x: i / SEGMENTS,
      y: HS * Math.sin((i * Math.PI * 2) / SEGMENTS),
    });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// FuseElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FuseElement extends AbstractCircuitElement {
  /** Timestamp (ms) when blown state was first detected in draw(). */
  private _smokeStartMs: number = -1;
  /** Previous blown state seen in draw(), for detecting the blow moment. */
  private _wasBlown: boolean = false;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Fuse", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(FUSE_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 0.4, width: COMP_WIDTH, height: 0.8 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();
    const blown = this._properties.getOrDefault<boolean>("blown", false);
    const thermalRatio = this._properties.getOrDefault<number>("_thermalRatio", 0);

    ctx.save();

    if (blown) {
      this._drawBlown(ctx, label);
    } else {
      this._drawIntact(ctx, signals, label, thermalRatio);
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Intact rendering — sine wave with heat glow
  // -------------------------------------------------------------------------

  private _drawIntact(
    ctx: RenderContext,
    signals: PinVoltageAccess | undefined,
    label: string,
    thermalRatio: number,
  ): void {
    // Line thickness increases with heat: 1 → 2.5
    const lineWidth = 1 + thermalRatio * 1.5;
    ctx.setLineWidth(lineWidth);

    const pts = sinePoints();

    // Apply jitter near critical (ratio > 0.9)
    let jitteredPts = pts;
    if (thermalRatio > 0.9) {
      const jitterAmp = (thermalRatio - 0.9) * 0.15; // max 0.015 grid units
      jitteredPts = pts.map((p, i) => ({
        x: p.x,
        y: p.y + jitterAmp * Math.sin(i * 7.3 + Date.now() * 0.01),
      }));
    }

    // Color: voltage gradient if available, otherwise heat-based
    if (thermalRatio > 0.3 && ctx.setRawColor) {
      ctx.setRawColor(heatColor(thermalRatio));
    } else {
      const v1 = signals?.getPinVoltage("out1");
      const v2 = signals?.getPinVoltage("out2");
      if (v1 !== undefined && v2 !== undefined && ctx.setLinearGradient) {
        ctx.setLinearGradient(0, 0, 1, 0, [
          { offset: 0, color: signals!.voltageColor(v1) },
          { offset: 1, color: signals!.voltageColor(v2) },
        ]);
      } else {
        ctx.setColor("COMPONENT");
      }
    }

    for (let i = 0; i < jitteredPts.length - 1; i++) {
      ctx.drawLine(jitteredPts[i].x, jitteredPts[i].y, jitteredPts[i + 1].x, jitteredPts[i + 1].y);
    }

    this._drawLabel(ctx, label);
  }

  // -------------------------------------------------------------------------
  // Blown rendering — broken wire with warped ends + smoke
  // -------------------------------------------------------------------------

  private _drawBlown(ctx: RenderContext, label: string): void {
    // Detect blow moment for smoke animation
    if (!this._wasBlown) {
      this._wasBlown = true;
      this._smokeStartMs = Date.now();
    }

    ctx.setLineWidth(1.5);

    // Draw left half — warped downward at break
    if (ctx.setRawColor) {
      ctx.setRawColor(lerpRgb(COLOR_CHARRED, COLOR_CHARRED, 0));
    } else {
      ctx.setColor("COMPONENT");
    }

    const pts = sinePoints();
    const mid = Math.floor(SEGMENTS / 2); // break at center

    // Left stub: segments 0 → mid-1, last point droops down
    for (let i = 0; i < mid - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }
    // Droop the break end downward
    const leftEnd = pts[mid - 1];
    ctx.drawLine(
      leftEnd.x, leftEnd.y,
      leftEnd.x + 0.02, leftEnd.y + 0.12,
    );

    // Right stub: segments mid+1 → end, first point droops up
    const rightStart = pts[mid + 1];
    ctx.drawLine(
      rightStart.x - 0.02, rightStart.y - 0.12,
      rightStart.x, rightStart.y,
    );
    for (let i = mid + 1; i < pts.length - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }

    // Gap marker — small flash/spark lines at the break
    if (ctx.setRawColor) {
      ctx.setRawColor("rgb(200,80,20)");
    }
    const gapX = 0.5;
    ctx.drawLine(gapX - 0.04, -0.06, gapX + 0.04, 0.06);
    ctx.drawLine(gapX + 0.04, -0.06, gapX - 0.04, 0.06);

    // Smoke puff animation — fades over ~1.5 seconds
    this._drawSmoke(ctx);

    this._drawLabel(ctx, label);
  }

  // -------------------------------------------------------------------------
  // Smoke particle animation
  // -------------------------------------------------------------------------

  private _drawSmoke(ctx: RenderContext): void {
    if (this._smokeStartMs < 0) return;
    if (!ctx.setRawColor) return;

    const elapsed = (Date.now() - this._smokeStartMs) / 1000; // seconds
    const duration = 1.5;
    if (elapsed > duration) return; // animation complete

    const progress = elapsed / duration; // 0→1
    const opacity = Math.max(0, 1 - progress);

    // 5 smoke particles rising from the break point
    const gapX = 0.5;
    for (let i = 0; i < 5; i++) {
      const phase = i * 1.25;
      const px = gapX + Math.sin(phase + elapsed * 2) * 0.08 * (1 + i * 0.3);
      const py = -0.15 - elapsed * 0.4 * (1 + i * 0.15);
      const radius = 0.03 + progress * 0.06;
      const alpha = opacity * (1 - i * 0.15);
      if (alpha <= 0) continue;

      const gray = 120 + i * 15;
      ctx.setRawColor(`rgba(${gray},${gray},${gray},${alpha.toFixed(2)})`);
      ctx.drawArc(px, py, radius, 0, Math.PI * 2);
    }
  }

  // -------------------------------------------------------------------------
  // Label
  // -------------------------------------------------------------------------

  private _drawLabel(ctx: RenderContext, label: string): void {
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }
  }

  get blown(): boolean {
    return this._properties.getOrDefault<boolean>("blown", false);
  }
}

// ---------------------------------------------------------------------------
// executeFuse — flat simulation function
//
// Reads the blown property and writes the closed flag into state[stBase]
// for the bus resolver: blown=false → 1 (closed), blown=true → 0 (open).
// ---------------------------------------------------------------------------

export function executeFuse(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const stBase = layout.stateOffset(index);
  const blown = layout.getProperty(index, "blown") ?? false;
  state[stBase] = blown ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FUSE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
  { xmlName: "rCold", propertyKey: "rCold", convert: (v) => parseFloat(v) },
  { xmlName: "rBlown", propertyKey: "rBlown", convert: (v) => parseFloat(v) },
  { xmlName: "currentRating", propertyKey: "currentRating", convert: (v) => parseFloat(v) },
  { xmlName: "i2tRating", propertyKey: "i2tRating", convert: (v) => parseFloat(v) },
];

const FUSE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the switched signal",
  },
  {
    key: "blown",
    type: PropertyType.BOOLEAN,
    label: "Blown",
    defaultValue: false,
    description: "When true, fuse is permanently open (non-conducting)",
  },
  {
    key: "rCold",
    type: PropertyType.FLOAT,
    label: "Cold Resistance (Ω)",
    defaultValue: 0.01,
    min: 1e-12,
    description: "Resistance when fuse is intact (analog mode)",
  },
  {
    key: "rBlown",
    type: PropertyType.FLOAT,
    label: "Blown Resistance (Ω)",
    defaultValue: 1e9,
    min: 1,
    description: "Resistance when fuse has blown (analog mode)",
  },
  {
    key: "currentRating",
    type: PropertyType.FLOAT,
    label: "Current Rating (A)",
    defaultValue: 0.1,
    min: 1e-6,
    description: "Continuous current rating in amperes",
  },
  {
    key: "i2tRating",
    type: PropertyType.FLOAT,
    label: "I²t Rating (A²·s)",
    defaultValue: 1e-4,
    min: 1e-12,
    description: "Energy rating: fuse blows when accumulated I²·t exceeds this value (10ms at 100mA)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

// ---------------------------------------------------------------------------
// FuseDefinition
// ---------------------------------------------------------------------------

function fuseFactory(props: PropertyBag): FuseElement {
  return new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const FuseDefinition: ComponentDefinition = {
  name: "Fuse",
  typeId: -1,
  factory: fuseFactory,
  pinLayout: FUSE_PIN_DECLARATIONS,
  propertyDefs: FUSE_PROPERTY_DEFS,
  attributeMap: FUSE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText:
    "Fuse — one-time irreversible switch with I²t thermal model.\n" +
    "Digital: blown property controls open/closed.\n" +
    "Simplified: blows when accumulated I²t exceeds the rating.",
  models: {
    digital: {
      executeFn: executeFuse,
      inputSchema: [],
      outputSchema: ["out1", "out2"],
      stateSlotCount: 1,
      switchPins: [0, 1],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createAnalogFuseElement,
      paramDefs: ANALOG_FUSE_PARAM_DEFS,
      params: ANALOG_FUSE_DEFAULTS,
    },
  },
  defaultModel: "digital",
};
