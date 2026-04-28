/**
 * SCR (Silicon Controlled Rectifier) analog component.
 *
 * Composite of two BJT sub-elements in a two-transistor latch configuration
 * per PB-SCR spec (bjtsetup.c:347-465 per sub-element).
 *
 *   Q1 — NPN (polarity = +1): B=G, C=Vint, E=K
 *   Q2 — PNP (polarity = -1): B=Vint, C=G, E=A
 *
 * Internal node: Vint (latch node) — created once by the composite in setup().
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
import { defineModelParams } from "../../core/model-params.js";

import {
  createBjtElement,
  createPnpBjtElement,
  BJT_NPN_DEFAULTS,
  BJT_PNP_DEFAULTS,
} from "./bjt.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SCR_PARAM_DEFS, defaults: SCR_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    BF: { default: 100,   description: "NPN forward current gain (Q1)" },
    BR: { default: 100,   description: "PNP reverse current gain (Q2)" },
    IS: { default: 1e-16, unit: "A", description: "Saturation current (shared)" },
  },
  secondary: {
    RC: { default: 0,     unit: "Ω", description: "Collector resistance (shared)" },
    RB: { default: 0,     unit: "Ω", description: "Base resistance (shared)" },
    RE: { default: 0,     unit: "Ω", description: "Emitter resistance (shared)" },
  },
  instance: {
    AREA: { default: 1,      description: "Device area factor" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" },
  },
});

// ---------------------------------------------------------------------------
// Helpers to build PropertyBag for sub-elements
// ---------------------------------------------------------------------------

function makeNpnProps(BF: number, IS: number, RC: number, RB: number, RE: number, AREA: number, TEMP: number): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...BJT_NPN_DEFAULTS, BF, IS, RC, RB, RE, AREA, TEMP });
  return bag;
}

function makePnpProps(BR: number, IS: number, RC: number, RB: number, RE: number, AREA: number, TEMP: number): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...BJT_PNP_DEFAULTS, BR, IS, RC, RB, RE, AREA, TEMP });
  return bag;
}

// ---------------------------------------------------------------------------
// ScrCompositeElement — composite AnalogElementCore
// ---------------------------------------------------------------------------

class ScrCompositeElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  private _aNode: number;
  private _kNode: number;
  private _gNode: number;
  private _vintNode: number = -1;
  private _internalLabels: string[] = [];

  readonly _q1: ReturnType<typeof createBjtElement>;  // NPN: B=G, C=Vint, E=K
  readonly _q2: ReturnType<typeof createBjtElement>;  // PNP: B=Vint, C=G, E=A

  constructor(
    label: string,
    pinNodes: ReadonlyMap<string, number>,
    q1: ReturnType<typeof createBjtElement>,
    q2: ReturnType<typeof createBjtElement>,
  ) {
    this.label = label;
    this._pinNodes = new Map(pinNodes);
    this._aNode = pinNodes.get("A")!;
    this._kNode = pinNodes.get("K")!;
    this._gNode = pinNodes.get("G")!;
    this._q1 = q1;
    this._q2 = q2;
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  setup(ctx: SetupContext): void {
    this._internalLabels = [];
    // Create the shared internal latch node first
    this._vintNode = ctx.makeVolt(this.label, "latch");
    this._internalLabels.push("latch");

    // Bind sub-element pin nodes using the resolved Vint.
    // Sub-element pin rebinding uses direct pinNodeIds array assignment
    // (consistent with PB-OPTO, PB-DAC, PB-OPAMP, PB-TIMER555). No setPinNode API is added
    // to AnalogElementCore.
    // Q1 NPN: BJT pin order [B, C, E] per buildBJTPinDeclarations()
    (this._q1 as any)._pinNodes.set("B", this._gNode);    // B=G
    (this._q1 as any)._pinNodes.set("C", this._vintNode); // C=Vint
    (this._q1 as any)._pinNodes.set("E", this._kNode);    // E=K

    // Q2 PNP: BJT pin order [B, C, E] per buildBJTPinDeclarations()
    (this._q2 as any)._pinNodes.set("B", this._vintNode); // B=Vint
    (this._q2 as any)._pinNodes.set("C", this._gNode);    // C=G
    (this._q2 as any)._pinNodes.set("E", this._aNode);    // E=A

    // Forward to each BJT sub-element (Q1 then Q2)
    this._q1.setup(ctx);   // NPN: 23× TSTALLOC per bjtsetup.c:435-464
    this._q2.setup(ctx);   // PNP: 23× TSTALLOC per bjtsetup.c:435-464
  }

  load(ctx: LoadContext): void {
    this._q1.load(ctx);   // NPN BJT load per bjtload.c
    this._q2.load(ctx);   // PNP BJT load per bjtload.c (polarity = -1)
  }

  setParam(key: string, value: number): void {
    if (key === "BF") {
      this._q1.setParam("BF", value);
    } else if (key === "BR") {
      this._q2.setParam("BR", value);
    } else if (key === "IS" || key === "RC" || key === "RB" || key === "RE" || key === "AREA" || key === "TEMP") {
      this._q1.setParam(key, value);
      this._q2.setParam(key, value);
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// createScrElement — composite factory
// ---------------------------------------------------------------------------

function createScrElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): ScrCompositeElement {
  const label = props.getOrDefault<string>("label", "") || "SCR";

  const BF   = props.getModelParam<number>("BF");
  const BR   = props.getModelParam<number>("BR");
  const IS   = props.getModelParam<number>("IS");
  const RC   = props.getModelParam<number>("RC");
  const RB   = props.getModelParam<number>("RB");
  const RE   = props.getModelParam<number>("RE");
  const AREA = props.getModelParam<number>("AREA");
  const TEMP = props.getModelParam<number>("TEMP");

  const npnProps = makeNpnProps(BF, IS, RC, RB, RE, AREA, TEMP);
  const pnpProps = makePnpProps(BR, IS, RC, RB, RE, AREA, TEMP);

  // Q1 NPN: B=G, C=Vint, E=K — Vint not known yet; overwritten in setup()
  const q1 = createBjtElement(
    new Map([["B", pinNodes.get("G")!], ["C", 0], ["E", pinNodes.get("K")!]]),
    npnProps,
    () => 0,
  );
  (q1 as any).label = `${label}#Q1`;

  // Q2 PNP: B=Vint, C=G, E=A — Vint not known yet; overwritten in setup()
  const q2 = createPnpBjtElement(
    new Map([["B", 0], ["C", pinNodes.get("G")!], ["E", pinNodes.get("A")!]]),
    pnpProps,
    () => 0,
  );
  (q2 as any).label = `${label}#Q2`;

  return new ScrCompositeElement(label, pinNodes, q1, q2);
}

// ---------------------------------------------------------------------------
// ScrElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SCR", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildScrPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 2.5,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body (triangle and cathode bar) stays COMPONENT color
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, 2.5, 0, 4, 0);

    // Gate lead: diagonal from cathode bar to pin G at (3,1)
    drawColoredLead(ctx, signals, vG, 2.5, 0, 3, 1);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildScrPinDeclarations(): PinDeclaration[] {
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
      direction: PinDirection.INPUT,
      label: "K",
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
      position: { x: 3, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCR_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SCR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ScrDefinition
// ---------------------------------------------------------------------------

function scrCircuitFactory(props: PropertyBag): ScrElement {
  return new ScrElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ScrDefinition: ComponentDefinition = {
  name: "SCR",
  typeId: -1,
  factory: scrCircuitFactory,
  pinLayout: buildScrPinDeclarations(),
  propertyDefs: SCR_PROPERTY_DEFS,
  attributeMap: SCR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "SCR — Silicon Controlled Rectifier.\n" +
    "Pins: A (anode), K (cathode), G (gate).\n" +
    "Two-transistor latch model: Q1 NPN (B=G, C=Vint, E=K) + Q2 PNP (B=Vint, C=G, E=A).",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createScrElement,
      paramDefs: SCR_PARAM_DEFS,
      params: SCR_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
