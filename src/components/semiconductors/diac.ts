/**
 * Diac analog component- bidirectional trigger diode.
 *
 * Blocks in both directions until |V| exceeds breakover voltage V_BO,
 * then conducts with negative-resistance snap.
 * Symmetric device- no gate terminal.
 *
 * Implemented as a composite of two antiparallel DIO sub-elements:
 *   D_fwd: posNode=A, negNode=B  (conducts for positive V(A,B))
 *   D_rev: posNode=B, negNode=A  (conducts for negative V(A,B))
 * Both sub-elements have breakdown enabled (BV = DIAC breakover voltage).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import {
  DIODE_PARAM_DEFS,
  DIODE_PARAM_DEFAULTS,
} from "./diode.js";

export { DIODE_PARAM_DEFS as DIAC_PARAM_DEFS, DIODE_PARAM_DEFAULTS as DIAC_PARAM_DEFAULTS };

// ---------------------------------------------------------------------------
// DIAC_NETLIST  MnaSubcircuitNetlist declaration
// ---------------------------------------------------------------------------

export const DIAC_NETLIST: MnaSubcircuitNetlist = {
  ports: ["A", "B"],
  params: { ...DIODE_PARAM_DEFAULTS },
  elements: [
    { typeId: "Diode", modelRef: "spice", subElementName: "D_fwd",
      params: { IS: "IS", N: "N", RS: "RS", CJO: "CJO", VJ: "VJ", M: "M", TT: "TT", FC: "FC", BV: "BV", IBV: "IBV", NBV: "NBV", IKF: "IKF", IKR: "IKR", EG: "EG", XTI: "XTI", KF: "KF", AF: "AF", TNOM: "TNOM", ISW: "ISW", NSW: "NSW", AREA: "AREA", OFF: "OFF", IC: "IC", TEMP: "TEMP" } },
    { typeId: "Diode", modelRef: "spice", subElementName: "D_rev",
      params: { IS: "IS", N: "N", RS: "RS", CJO: "CJO", VJ: "VJ", M: "M", TT: "TT", FC: "FC", BV: "BV", IBV: "IBV", NBV: "NBV", IKF: "IKF", IKR: "IKR", EG: "EG", XTI: "XTI", KF: "KF", AF: "AF", TNOM: "TNOM", ISW: "ISW", NSW: "NSW", AREA: "AREA", OFF: "OFF", IC: "IC", TEMP: "TEMP" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1],  // D_fwd: A=A,  K=B
    [1, 0],  // D_rev: A=B,  K=A
  ],
};

// ---------------------------------------------------------------------------
// DiacElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class DiacElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Diac", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildDiacPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const hs = 1.0;

    // A lead
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // B lead
    drawColoredLead(ctx, signals, vB, 2.5, 0, 4, 0);

    // Body (plate bars and triangles) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // plate1 bar at x=1.5
    ctx.drawLine(1.5, -hs, 1.5, hs);
    // plate2 bar at x=2.5
    ctx.drawLine(2.5, -hs, 2.5, hs);

    // arr0: forward triangle pointing right
    ctx.drawPolygon([
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 1.0 },
      { x: 2.5, y: 0 },
    ], true);

    // arr1: reverse triangle pointing left
    ctx.drawPolygon([
      { x: 2.5, y: -0.5 },
      { x: 1.5, y: -1.0 },
      { x: 1.5, y: 0 },
    ], true);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -1.25, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildDiacPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DIAC_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const DIAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// DiacDefinition
// ---------------------------------------------------------------------------

function diacCircuitFactory(props: PropertyBag): DiacElement {
  return new DiacElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DiacDefinition: StandaloneComponentDefinition = {
  name: "Diac",
  typeId: -1,
  factory: diacCircuitFactory,
  pinLayout: buildDiacPinDeclarations(),
  propertyDefs: DIAC_PROPERTY_DEFS,
  attributeMap: DIAC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Diac- bidirectional trigger diode.\n" +
    "Pins: A (terminal 1), B (terminal 2).\n" +
    "Blocks until |V| > BV (breakover voltage), then conducts bidirectionally.",
  models: {},
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIAC_NETLIST,
      paramDefs: DIODE_PARAM_DEFS,
      params: DIODE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "default",
};
