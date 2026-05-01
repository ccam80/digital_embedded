/**
 * LED component- single-color indicator.
 *
 * Renders as a circle with configurable color. Lit state derives from the
 * analog forward voltage compared against a per-color illumination
 * threshold; the digital model treats it as a 1-bit indicator.
 *
 * Analog model: single-port diode with cathode wired to ground (node 0).
 * The five color modelRegistry entries delegate to createDiodeElement with
 * per-color IS/N parameter overrides.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
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
import type { AnalogElement } from "../../core/analog-types.js";
import {
  createDiodeElement,
  DIODE_PARAM_DEFS,
} from "../semiconductors/diode.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildLedPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Per-color VD illumination-perception threshold
// ---------------------------------------------------------------------------

const LIT_THRESHOLD_TABLE: Record<string, number> = {
  red:    1.6,
  yellow: 1.9,
  green:  2.1,
  blue:   2.6,
  white:  2.6,
};

export function getLitThreshold(color: string): number {
  return LIT_THRESHOLD_TABLE[color] ?? LIT_THRESHOLD_TABLE.red;
}

// ---------------------------------------------------------------------------
// LedElement- UI-facing CircuitElement
// ---------------------------------------------------------------------------

export class LedElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LED", instanceId, position, rotation, mirror, props);
  }

  get color(): string {
    return this._properties.getOrDefault<string>("color", "red");
  }

  /**
   * Lit-state getter for the renderer. Cathode is wired to ground (node 0)
   * by the analog adapter, so the "in" pin voltage equals the diode's
   * forward voltage Vd. Returns true when Vd exceeds the per-color
   * illumination threshold.
   */
  isLit(signals: PinVoltageAccess | undefined): boolean {
    const v = signals?.getPinVoltage("in");
    if (v === undefined || !Number.isFinite(v)) return false;
    return v > getLitThreshold(this.color);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildLedPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Circle at cx=0.8 r=0.75: minX = 0.8-0.75, maxX = 0.8+0.75, minY = -0.75, maxY = 0.75.
    // Use cx-r arithmetic to match ellipseSegments cardinal sentinel values exactly.
    const cx = 0.8, r = 0.75;
    return {
      x: this.position.x + (cx - r),
      y: this.position.y - r,
      width: 2 * r,
      height: 2 * r,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();
    const lit = this.isLit(signals);

    ctx.save();

    // Outer filled circle (body) at (0.8, 0) r=0.75
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(0.8, 0, 0.75, true);

    // Inner color zone circle at (0.8, 0) r=0.65
    ctx.drawCircle(0.8, 0, 0.65, true);

    // Bright central highlight when lit- visual indication that Vd has
    // crossed the per-color threshold.
    if (lit) {
      ctx.drawCircle(0.8, 0, 0.3, true);
    }

    // Label to the right
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(label, 2.25, 0, {
      horizontal: "left",
      vertical: "middle",
    });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeLed- reads input, writes to output slot for display state
// ---------------------------------------------------------------------------

export function executeLed(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputVal = state[wt[layout.inputOffset(index)]];
  state[wt[layout.outputOffset(index)]] = inputVal !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// createLedAnalogElementViaDiode- pin-remap adapter
// ---------------------------------------------------------------------------

function createLedAnalogElementViaDiode(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
): AnalogElement {
  // Inject K=0 (cathode → ground); remap "in" → "A".
  const remappedPinNodes = new Map<string, number>([
    ["A", pinNodes.get("in")!],
    ["K", 0],
  ]);
  return createDiodeElement(remappedPinNodes, props, getTime);
}

// ---------------------------------------------------------------------------
// LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Color",
    propertyKey: "color",
    convert: (v) => v,
  },
  {
    xmlName: "Color",
    propertyKey: "model",
    convert: (v) => v.toLowerCase(),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const LED_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the LED",
  },
  {
    key: "color",
    type: PropertyType.COLOR,
    label: "Color",
    defaultValue: "red",
    description: "LED color when lit",
  },
];

// ---------------------------------------------------------------------------
// LedDefinition
// ---------------------------------------------------------------------------

function ledFactory(props: PropertyBag): LedElement {
  return new LedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const LedDefinition: ComponentDefinition = {
  name: "LED",
  typeId: -1,
  factory: ledFactory,
  pinLayout: buildLedPinDeclarations(),
  propertyDefs: LED_PROPERTY_DEFS,
  attributeMap: LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "LED  single-color light-emitting diode indicator.\n" +
    "Lights up (filled circle) when the input is non-zero.\n" +
    "Color is configurable. Label is shown above the component.",
  ngspiceNodeMap: { in: "pos" },
  models: {
    digital: { executeFn: executeLed, inputSchema: ["in"], outputSchema: [] },
  },
  modelRegistry: {
    red:    { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
              params: { IS: 3.17e-19, N: 1.8, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                        VJ: 1, M: 0.5, FC: 0.5 } },
    green:  { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
              params: { IS: 1e-21, N: 2.0, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                        VJ: 1, M: 0.5, FC: 0.5 } },
    blue:   { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
              params: { IS: 6.26e-24, N: 2.5, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                        VJ: 1, M: 0.5, FC: 0.5 } },
    yellow: { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
              params: { IS: 1e-20, N: 1.9, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                        VJ: 1, M: 0.5, FC: 0.5 } },
    white:  { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
              params: { IS: 6.26e-24, N: 2.5, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                        VJ: 1, M: 0.5, FC: 0.5 } },
  },
  defaultModel: "digital",
};
