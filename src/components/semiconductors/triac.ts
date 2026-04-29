/**
 * Triac analog component  bidirectional thyristor.
 *
 * Composite: two anti-parallel SCRs sharing a gate terminal, each built from
 * the NPN+PNP two-transistor latch per PB-SCR / PB-BJT.
 *
 * Sub-elements (NGSPICE_LOAD_ORDER ascending, all BJT=2):
 *   Q1 — NPN SCR1: B=G, C=Vint1, E=MT1
 *   Q2 — PNP SCR1: B=Vint1, C=G, E=MT2
 *   Q3 — NPN SCR2: B=G, C=Vint2, E=MT2
 *   Q4 — PNP SCR2: B=Vint2, C=G, E=MT1
 *
 * Internal nodes:
 *   Vint1 — SCR1 latch node (created in setup())
 *   Vint2 — SCR2 latch node (created in setup())
 *
 * Terminal convention:
 *   MT1  Main Terminal 1 (reference terminal for gate control)
 *   MT2  Main Terminal 2
 *   G    Gate
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
import type { AnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";

import {
  createBjtElement,
  createPnpBjtElement,
  BJT_NPN_DEFAULTS,
  BJT_PNP_DEFAULTS,
} from "./bjt.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRIAC_PARAM_DEFS, defaults: TRIAC_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: BJT_NPN_DEFAULTS.BF,  description: "Forward current gain (NPN, Q1/Q3)" },
    IS:  { default: BJT_NPN_DEFAULTS.IS,  unit: "A", description: "Saturation current (all sub-BJTs)" },
  },
  secondary: {
    BR:  { default: BJT_PNP_DEFAULTS.BR,  description: "Reverse current gain (PNP, Q2/Q4)" },
    RC:  { default: 0,                     unit: "Ω", description: "Collector resistance" },
    RB:  { default: 0,                     unit: "Ω", description: "Base resistance" },
    RE:  { default: 0,                     unit: "Ω", description: "Emitter resistance" },
    AREA: { default: 1,                    description: "Device area factor" },
    TEMP: { default: 300.15,               unit: "K", description: "Operating temperature", spiceConverter: kelvinToCelsius },
  },
});

// ---------------------------------------------------------------------------
// TriacCompositeElement — composite AnalogElement
// ---------------------------------------------------------------------------

class TriacCompositeElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _q1: ReturnType<typeof createBjtElement>;
  readonly _q2: ReturnType<typeof createBjtElement>;
  readonly _q3: ReturnType<typeof createBjtElement>;
  readonly _q4: ReturnType<typeof createBjtElement>;

  _mt1Node: number = 0;
  _mt2Node: number = 0;
  _gNode:   number = 0;
  _vint1Node: number = 0;
  _vint2Node: number = 0;

  private readonly _internalLabels: string[] = [];

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    q1: ReturnType<typeof createBjtElement>,
    q2: ReturnType<typeof createBjtElement>,
    q3: ReturnType<typeof createBjtElement>,
    q4: ReturnType<typeof createBjtElement>,
  ) {
    this._pinNodes = new Map(pinNodes);
    this._mt1Node = pinNodes.get("MT1")!;
    this._mt2Node = pinNodes.get("MT2")!;
    this._gNode   = pinNodes.get("G")!;
    this._q1 = q1;
    this._q2 = q2;
    this._q3 = q3;
    this._q4 = q4;
  }

  setup(ctx: SetupContext): void {
    // Create internal latch nodes before sub-elements
    this._vint1Node = ctx.makeVolt(this.label, "latch1");  // SCR1 latch
    this._internalLabels.push("latch1");
    this._vint2Node = ctx.makeVolt(this.label, "latch2");  // SCR2 latch
    this._internalLabels.push("latch2");

    // Bind sub-element pin nodes by mutating each BJT's _pinNodes map.
    // BJT sub-elements are not compiler-augmented, so pinNodeIds is unset on
    // them and bjt.ts::setup() reads node IDs from this._pinNodes.get("B"|"C"|"E").

    // Q1 NPN SCR1: B=G, C=Vint1, E=MT1
    (this._q1 as any)._pinNodes.set("B", this._gNode);
    (this._q1 as any)._pinNodes.set("C", this._vint1Node);
    (this._q1 as any)._pinNodes.set("E", this._mt1Node);

    // Q2 PNP SCR1: B=Vint1, C=G, E=MT2
    (this._q2 as any)._pinNodes.set("B", this._vint1Node);
    (this._q2 as any)._pinNodes.set("C", this._gNode);
    (this._q2 as any)._pinNodes.set("E", this._mt2Node);

    // Q3 NPN SCR2: B=G, C=Vint2, E=MT2
    (this._q3 as any)._pinNodes.set("B", this._gNode);
    (this._q3 as any)._pinNodes.set("C", this._vint2Node);
    (this._q3 as any)._pinNodes.set("E", this._mt2Node);

    // Q4 PNP SCR2: B=Vint2, C=G, E=MT1
    (this._q4 as any)._pinNodes.set("B", this._vint2Node);
    (this._q4 as any)._pinNodes.set("C", this._gNode);
    (this._q4 as any)._pinNodes.set("E", this._mt1Node);

    // Forward to each BJT sub-element in order
    this._q1.setup(ctx);   // 23× TSTALLOC
    this._q2.setup(ctx);   // 23× TSTALLOC
    this._q3.setup(ctx);   // 23× TSTALLOC
    this._q4.setup(ctx);   // 23× TSTALLOC
  }

  load(ctx: LoadContext): void {
    this._q1.load(ctx);   // NPN bjtload.c
    this._q2.load(ctx);   // PNP bjtload.c (polarity = -1)
    this._q3.load(ctx);   // NPN bjtload.c
    this._q4.load(ctx);   // PNP bjtload.c (polarity = -1)
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  setParam(key: string, value: number): void {
    if (key === "BF") {
      // BF routes to Q1 and Q3 (NPN forward gain)
      this._q1.setParam("BF", value);
      this._q3.setParam("BF", value);
    } else if (key === "BR") {
      // BR routes to Q2 and Q4 (PNP reverse gain)
      this._q2.setParam("BR", value);
      this._q4.setParam("BR", value);
    } else if (key === "IS" || key === "RC" || key === "RB" || key === "RE" || key === "AREA" || key === "TEMP") {
      // Shared model parameters route to all four sub-elements
      this._q1.setParam(key, value);
      this._q2.setParam(key, value);
      this._q3.setParam(key, value);
      this._q4.setParam(key, value);
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    // Pin order: [MT2(0), MT1(1), G(2)]
    return [0, 0, 0];
  }

  /** Sub-elements in setup() order: Q1, Q2, Q3, Q4 BJTs. Each is independent
   *  in setup; setup() rebinds their pin nodes via internal latch nodes. */
  getSubElements(): readonly AnalogElement[] {
    return [
      this._q1 as unknown as AnalogElement,
      this._q2 as unknown as AnalogElement,
      this._q3 as unknown as AnalogElement,
      this._q4 as unknown as AnalogElement,
    ];
  }
}

// ---------------------------------------------------------------------------
// createTriacElement  AnalogElement factory (3-arg signature per A.3)
// ---------------------------------------------------------------------------

function createTriacElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const mt1Node = pinNodes.get("MT1")!;
  const mt2Node = pinNodes.get("MT2")!;
  const gNode   = pinNodes.get("G")!;

  // Q1 NPN SCR1: B=G, C=Vint1(placeholder 0), E=MT1
  const q1 = createBjtElement(
    new Map([["B", gNode], ["C", 0], ["E", mt1Node]]),
    props,
    () => 0,
  );
  (q1 as any).ngspiceNodeMap = { B: "base", C: "col", E: "emit" };

  // Q2 PNP SCR1: B=Vint1(placeholder 0), C=G, E=MT2
  const q2 = createPnpBjtElement(
    new Map([["B", 0], ["C", gNode], ["E", mt2Node]]),
    props,
    () => 0,
  );
  (q2 as any).ngspiceNodeMap = { B: "base", C: "col", E: "emit" };

  // Q3 NPN SCR2: B=G, C=Vint2(placeholder 0), E=MT2
  const q3 = createBjtElement(
    new Map([["B", gNode], ["C", 0], ["E", mt2Node]]),
    props,
    () => 0,
  );
  (q3 as any).ngspiceNodeMap = { B: "base", C: "col", E: "emit" };

  // Q4 PNP SCR2: B=Vint2(placeholder 0), C=G, E=MT1
  const q4 = createPnpBjtElement(
    new Map([["B", 0], ["C", gNode], ["E", mt1Node]]),
    props,
    () => 0,
  );
  (q4 as any).ngspiceNodeMap = { B: "base", C: "col", E: "emit" };

  return new TriacCompositeElement(pinNodes, q1, q2, q3, q4);
}

// ---------------------------------------------------------------------------
// TriacElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class TriacElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Triac", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTriacPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 3,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vMT2 = signals?.getPinVoltage("MT2");
    const vMT1 = signals?.getPinVoltage("MT1");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Reference pixel coords divided by 16 for grid units
    // Component spans x=0..4, y=-2..0 (pin 2 at (4,-2))
    const bar1x = 24 / 16; // 1.5
    const bar2x = 40 / 16; // 2.5

    // Body: two vertical bars and bidirectional arrow triangles
    // Bar 1 at x=1.5, from y=-1 to y=+1
    ctx.drawLine(bar1x, -1,     bar1x, 1);
    // Bar 2 at x=2.5, from y=-1 to y=+1
    ctx.drawLine(bar2x, -1,     bar2x, 1);

    // Forward arrow triangle (pointing right): (bar1x, 0.5)  (bar2x, 1.0)  (bar2x, 0)
    ctx.drawPolygon([
      { x: bar1x, y:  8 / 16 },
      { x: bar2x, y: 16 / 16 },
      { x: bar2x, y: 0 },
    ], true);

    // Reverse arrow triangle (pointing left): (bar2x, -0.5)  (bar1x, -1.0)  (bar1x, 0)
    ctx.drawPolygon([
      { x: bar2x, y:  -8 / 16 },
      { x: bar1x, y: -16 / 16 },
      { x: bar1x, y: 0 },
    ], true);

    // MT2 lead: pin 0 at (0,0)  bar1 at (1.5,0)
    drawColoredLead(ctx, signals, vMT2, 0, 0, bar1x, 0);

    // MT1 lead: bar2 at (2.5,0)  pin 1 at (4,0)
    drawColoredLead(ctx, signals, vMT1, bar2x, 0, 4, 0);

    // Gate lead: (2.5,0)  (4,-1.5)  (4,-2) to pin 2
    drawColoredLead(ctx, signals, vG, bar2x, 0, 4, -24 / 16);
    ctx.drawLine(4, -24 / 16, 4, -2);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTriacPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "MT2",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "MT1",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 4, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRIAC_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRIAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// TriacDefinition
// ---------------------------------------------------------------------------

function triacCircuitFactory(props: PropertyBag): TriacElement {
  return new TriacElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TriacDefinition: ComponentDefinition = {
  name: "Triac",
  typeId: -1,
  factory: triacCircuitFactory,
  pinLayout: buildTriacPinDeclarations(),
  propertyDefs: TRIAC_PROPERTY_DEFS,
  attributeMap: TRIAC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Triac  bidirectional thyristor.\n" +
    "Pins: MT1 (main terminal 1), MT2 (main terminal 2), G (gate).\n" +
    "Conducts in both directions when triggered. Turns off at current zero-crossing.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTriacElement,
      paramDefs: TRIAC_PARAM_DEFS,
      params: TRIAC_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
