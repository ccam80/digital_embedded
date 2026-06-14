/**
 * DC Current Source  ideal independent current source for MNA simulation.
 *
 * Stamps only into the RHS vector  no G-matrix entries required.
 * Reads `ctx.srcFact` (ngspice CKTsrcFact) directly inside load() to apply
 * DC-OP source stepping  matches ngspice isrcload.c exactly.
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { AnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { MODEDCOP, MODEDCTRANCURVE, MODETRANOP } from "../../solver/analog/ckt-mode.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: DC_CURRENT_SOURCE_PARAM_DEFS, defaults: DC_CURRENT_SOURCE_DEFAULTS } = defineModelParams({
  primary: {
    current: { default: 0.01, unit: "A", description: "Source current in amperes" },
  },
  secondary: {
    // isrc.c:15 / isrctemp.c:62-63 — ISRCmValue parallel multiplier, default 1.
    m: { default: 1, unit: "", description: "Parallel multiplier (ngspice ISRCmValue)" },
  },
});

// ---------------------------------------------------------------------------
// DcCurrentSourceElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class DcCurrentSourceElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DcCurrentSource", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const decls = DC_CURRENT_SOURCE_PIN_LAYOUT;
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

    // Lead from neg pin (x=0) to body  thick
    drawColoredLead(ctx, signals, vNeg, 0, 0, 1.1875, 0);

    // Lead from pos pin (x=4) to body  thick
    drawColoredLead(ctx, signals, vPos, 2.8125, 0, 4, 0);

    // Body (circle and arrow) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Circle at center (32/16=2, r=11.76/16=0.735)
    ctx.drawCircle(2, 0, 0.735, false);

    // Arrow shaft (25/16=1.5625 to 35/16=2.1875)  thick
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

const DC_CURRENT_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
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

const DC_CURRENT_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
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

const DC_CURRENT_SOURCE_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Current", propertyKey: "current", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "M",       propertyKey: "m",       convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",   propertyKey: "label",   convert: (v) => v },
];

// ---------------------------------------------------------------------------
// analogFactory helper (exported for tests)
// ---------------------------------------------------------------------------

class DcCurrentSourceAnalogImpl extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.ISRC;
  readonly deviceFamily: DeviceFamily = "ISRC";

  private readonly _p: Record<string, number>;
  // Captures the srcFact seen on the most recent load() call so that
  // getPinCurrents can report consistent DC-OP source-stepped currents
  // to diagnostic readouts between iterations.
  private _lastSrcFact = 1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    // isrc.c:15 / isrctemp.c:62-63 — parallel multiplier, default 1 (the
    // paramDefs default supplies the !ISRCmGiven ⇒ 1 rule).
    this._p = {
      current: props.getModelParam<number>("current"),
      m: props.getModelParam<number>("m"),
    };
  }

  setup(_ctx: SetupContext): void {
    // ISRC has no *set.c in ngspice. No TSTALLOC, no internal nodes,
    // no branch row, no state slots. Body is intentionally empty.
  }

  setParam(key: string, value: number): void {
    if (key in this._p) this._p[key] = value;
  }

  load(ctx: LoadContext): void {
    this._lastSrcFact = ctx.srcFact;
    const nodePos = this.pinNodes.get("pos")!;
    const nodeNeg = this.pinNodes.get("neg")!;
    // isrcload.c:54/69 — the pure-DC value is source-stepped by srcFact across the
    // DC-analysis modes (MODEDC = MODEDCOP|MODEDCTRANCURVE|MODETRANOP); the MODEDC
    // default case (isrcload.c:69) scales the constant value, unlike vsrcload.c:93
    // which leaves it unramped. isrcload.c:382-383 then applies srcFact a second
    // time during the transient OP (MODETRANOP supply ramp), so a DC current source
    // ramps as srcFact² in MODETRANOP while a voltage source ramps as srcFact.
    let I = (ctx.cktMode & (MODEDCOP | MODEDCTRANCURVE | MODETRANOP))
      ? this._p.current * ctx.srcFact
      : this._p.current;
    if (ctx.cktMode & MODETRANOP) I *= ctx.srcFact;
    // isrcload.c:387-388/45 — the RHS stamp is scaled by the m parallel multiplier.
    stampRHS(ctx.rhs, nodePos,  this._p.m * I);
    stampRHS(ctx.rhs, nodeNeg, -this._p.m * I);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    // No branch row- current is defined by the stamp: I = current * srcFact.
    // Pin layout order: [neg, pos]- neg is index 0, pos is index 1.
    // Conventional current flows from neg through source to pos (arrow direction).
    // Current into neg = +I (current enters element at neg from the circuit).
    // Current into pos = -I (current exits element at pos into the circuit).
    // isrcload.c:392 — the recorded current is m-scaled (ISRCcurrent = m * value).
    const I = this._p.current * this._lastSrcFact * this._p.m;
    return [I, -I];
  }
}

export function makeDcCurrentSource(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  return new DcCurrentSourceAnalogImpl(pinNodes, props);
}

// ---------------------------------------------------------------------------
// StandaloneComponentDefinition
// ---------------------------------------------------------------------------

export const DcCurrentSourceDefinition: StandaloneComponentDefinition = {
  name: "DcCurrentSource",
  typeId: -1,
  category: ComponentCategory.SOURCES,

  pinLayout: DC_CURRENT_SOURCE_PIN_LAYOUT,
  voltageProbes: [{ name: "V", pos: "pos", neg: "neg" }],
  propertyDefs: DC_CURRENT_SOURCE_PROPERTY_DEFS,
  attributeMap: DC_CURRENT_SOURCE_ATTRIBUTE_MAP,

  helpText: "Ideal DC current source. Stamps only into the RHS vector  no matrix entries.",

  factory(props: PropertyBag): DcCurrentSourceElement {
    return new DcCurrentSourceElement(
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
      factory: makeDcCurrentSource,
      paramDefs: DC_CURRENT_SOURCE_PARAM_DEFS,
      params: {},
      spice: { device: "ISRC", deckNodeTokens: ["pos", "neg"] },
    },
  },
  defaultModel: "behavioral",
};
