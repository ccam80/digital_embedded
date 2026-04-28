/**
 * Diac analog component — bidirectional trigger diode.
 *
 * Blocks in both directions until |V| exceeds breakover voltage V_BO,
 * then conducts with negative-resistance snap.
 * Symmetric device — no gate terminal.
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
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import {
  createDiodeElement,
  DIODE_PARAM_DEFS,
  DIODE_PARAM_DEFAULTS,
} from "./diode.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";

// ---------------------------------------------------------------------------
// createDiacElement  AnalogElement factory
// ---------------------------------------------------------------------------

export function createDiacElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
): AnalogElementCore {
  const nodeA = pinNodes.get("A")!; // terminal A
  const nodeB = pinNodes.get("B")!; // terminal B

  // D_fwd: A=anode(pos), B=cathode(neg)  ngspiceNodeMap: { A: "pos", B: "neg" }
  const fwdNodes: ReadonlyMap<string, number> = new Map([
    ["A", nodeA],
    ["K", nodeB],
  ]);

  // D_rev: B=anode(pos), A=cathode(neg)  ngspiceNodeMap: { B: "pos", A: "neg" }
  const revNodes: ReadonlyMap<string, number> = new Map([
    ["A", nodeB],
    ["K", nodeA],
  ]);

  const parentLabel = props.getOrDefault<string>("label", "D");
  const fwdLabel = `${parentLabel}#D_fwd`;
  const revLabel = `${parentLabel}#D_rev`;

  const dFwd = createDiodeElement(fwdNodes, props, getTime);
  const dRev = createDiodeElement(revNodes, props, getTime);

  // Attach labels so setup()/load() diagnostics attribute correctly
  dFwd.label = fwdLabel;
  dRev.label = revLabel;

  return {
    branchIndex: -1,
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.DIO,
    isNonlinear: true,
    isReactive: false,

    setup(ctx: SetupContext): void {
      dFwd.setup(ctx);   // D_fwd: DIO with posNode=A, negNode=B
      dRev.setup(ctx);   // D_rev: DIO with posNode=B, negNode=A
    },

    load(ctx: LoadContext): void {
      dFwd.load(ctx);
      dRev.load(ctx);
    },

    checkConvergence(ctx: LoadContext): boolean {
      const fwdOk = dFwd.checkConvergence ? dFwd.checkConvergence(ctx) : true;
      const revOk = dRev.checkConvergence ? dRev.checkConvergence(ctx) : true;
      return fwdOk && revOk;
    },

    getPinCurrents(_rhs: Float64Array): number[] {
      // pinLayout order: [A (terminal 1), B (terminal 2)]
      const fwdCurrents = dFwd.getPinCurrents ? dFwd.getPinCurrents(_rhs) : [0, 0];
      const revCurrents = dRev.getPinCurrents ? dRev.getPinCurrents(_rhs) : [0, 0];
      // D_fwd: A-pin current from A→B, D_rev: A-pin current from B→A
      // Net current at A = fwd[0] + rev[1] (rev[1] is current at D_rev's K=nodeA)
      // Net current at B = fwd[1] + rev[0]
      return [
        fwdCurrents[0] + revCurrents[1],
        fwdCurrents[1] + revCurrents[0],
      ];
    },

    setParam(key: string, value: number): void {
      // Forward shared model parameters to both sub-elements
      dFwd.setParam?.(key, value);
      dRev.setParam?.(key, value);
    },
  };
}

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

export const DiacDefinition: ComponentDefinition = {
  name: "Diac",
  typeId: -1,
  factory: diacCircuitFactory,
  pinLayout: buildDiacPinDeclarations(),
  propertyDefs: DIAC_PROPERTY_DEFS,
  attributeMap: DIAC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Diac — bidirectional trigger diode.\n" +
    "Pins: A (terminal 1), B (terminal 2).\n" +
    "Blocks until |V| > BV (breakover voltage), then conducts bidirectionally.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiacElement,
      paramDefs: DIODE_PARAM_DEFS,
      params: DIODE_PARAM_DEFAULTS,
      mayCreateInternalNodes: true,
    },
  },
  defaultModel: "spice",
};
