/**
 * Current Source â€” ideal independent current source for MNA simulation.
 *
 * Stamps only into the RHS vector â€” no G-matrix entries required.
 * Reads `ctx.srcFact` (ngspice CKTsrcFact) directly inside load() to apply
 * DC-OP source stepping â€” matches ngspice isrcload.c exactly.
 *
 * MNA stamp convention (current I flows from nodeNeg to nodePos through source):
 *   RHS[nodePos] += I * srcFact   (current enters nodePos)
 *   RHS[nodeNeg] -= I * srcFact   (current leaves nodeNeg)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import { PinDirection, type Pin, type PinDeclaration, type Rotation } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: CURRENT_SOURCE_PARAM_DEFS, defaults: CURRENT_SOURCE_DEFAULTS } = defineModelParams({
  primary: {
    current: { default: 0.01, unit: "A", description: "Source current in amperes" },
  },
});

// ---------------------------------------------------------------------------
// CurrentSourceElement â€” CircuitElement implementation
// ---------------------------------------------------------------------------

export class CurrentSourceElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("CurrentSource", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const decls = CURRENT_SOURCE_PIN_LAYOUT;
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    // Circle center at x=2, r=11.76/16=0.735. Leads extend to x=0 and x=4.
    return {
      x: this.position.x,
      y: this.position.y - 0.735,
      width: 4,
      height: 1.47,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const current = this._properties.getModelParam<number>("current");
    const label = this._visibleLabel();
    const vNeg = signals?.getPinVoltage("neg");
    const vPos = signals?.getPinVoltage("pos");

    ctx.save();
    ctx.setLineWidth(1);

    // Lead from neg pin (x=0) to body â€” thick
    drawColoredLead(ctx, signals, vNeg, 0, 0, 1.1875, 0);

    // Lead from pos pin (x=4) to body â€” thick
    drawColoredLead(ctx, signals, vPos, 2.8125, 0, 4, 0);

    // Body (circle and arrow) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Circle at center (32/16=2, r=11.76/16=0.735)
    ctx.drawCircle(2, 0, 0.735, false);

    // Arrow shaft (25/16=1.5625 to 35/16=2.1875) â€” thick
    ctx.drawLine(1.5625, 0, 2.1875, 0);

    // Arrow head: points (38/16,0), (34/16,-4/16), (34/16,4/16)
    ctx.drawPolygon([
      { x: 2.375, y: 0 },
      { x: 2.125, y: -0.25 },
      { x: 2.125, y: 0.25 },
    ], true);

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(current, "A") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 2, 1, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const CURRENT_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
  {
    label: "neg",
    direction: PinDirection.OUTPUT,
    position: { x: 0, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    label: "pos",
    direction: PinDirection.INPUT,
    position: { x: 4, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CURRENT_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label",
  },
];

// ---------------------------------------------------------------------------
// Attribute map
// ---------------------------------------------------------------------------

const CURRENT_SOURCE_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Current", propertyKey: "current", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",   propertyKey: "label",   convert: (v) => v },
];

// ---------------------------------------------------------------------------
// analogFactory helper (exported for tests)
// ---------------------------------------------------------------------------

export function makeCurrentSource(
  nodePos: number,
  nodeNeg: number,
  current: number,
): AnalogElementCore {
  const p: Record<string, number> = { current };
  // Captures the srcFact seen on the most recent load() call so that
  // getPinCurrents can report consistent DC-OP source-stepped currents
  // to diagnostic readouts between iterations.
  let lastSrcFact = 1;

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.ISRC,
    isNonlinear: false,
    isReactive: false,

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },

    load(ctx: LoadContext): void {
      lastSrcFact = ctx.srcFact;
      const I = p.current * ctx.srcFact;
      if (nodePos !== 0) stampRHS(ctx.rhs,nodePos, I);
      if (nodeNeg !== 0) stampRHS(ctx.rhs,nodeNeg, -I);
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // No branch row â€” current is defined by the stamp: I = current * srcFact.
      // Pin layout order: [neg, pos] â€” neg is index 0, pos is index 1.
      // Conventional current flows from neg through source to pos (arrow direction).
      // Current into neg = +I (current enters element at neg from the circuit).
      // Current into pos = -I (current exits element at pos into the circuit).
      const I = p.current * lastSrcFact;
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const CurrentSourceDefinition: ComponentDefinition = {
  name: "CurrentSource",
  typeId: -1,
  category: ComponentCategory.SOURCES,

  pinLayout: CURRENT_SOURCE_PIN_LAYOUT,
  propertyDefs: CURRENT_SOURCE_PROPERTY_DEFS,
  attributeMap: CURRENT_SOURCE_ATTRIBUTE_MAP,

  helpText: "Ideal DC current source. Stamps only into the RHS vector â€” no matrix entries.",

  factory(props: PropertyBag): CurrentSourceElement {
    return new CurrentSourceElement(
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      props,
    );
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        _branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        const current = props.getModelParam<number>("current");
        return makeCurrentSource(pinNodes.get("pos")!, pinNodes.get("neg")!, current);
      },
      paramDefs: CURRENT_SOURCE_PARAM_DEFS,
      params: CURRENT_SOURCE_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
