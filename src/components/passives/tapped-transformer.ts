/**
 * Three-winding (center-tapped) transformer component.
 *
 * Models a transformer with one primary winding and two secondary halves
 * that share a center-tap terminal. The center-tap is the junction between
 * the two secondary half-windings, providing a midpoint voltage reference.
 *
 * Pin layout (5 physical terminals):
 *   P1   primary positive
 *   P2   primary negative
 *   S1   secondary half-1 positive (top end)
 *   CT   center tap (shared: sec-half-1 negative = sec-half-2 positive)
 *   S2   secondary half-2 negative (bottom end)
 *
 * Sub-element decomposition (composite setup/load pattern per PB-TAPXFMR):
 *   L1  (_l1): InductorSubElement — primary winding (P1 pos, P2 neg)
 *   L2  (_l2): InductorSubElement — secondary half-1 (S1 pos, CT neg)
 *   L3  (_l3): InductorSubElement — secondary half-2 (CT pos, S2 neg)
 *   MUT12 (_mut12): MutualInductorElement — coupling between L1 and L2
 *   MUT13 (_mut13): MutualInductorElement — coupling between L1 and L3
 *   MUT23 (_mut23): MutualInductorElement — coupling between L2 and L3
 *
 * Inductance relationships for turns ratio N (total secondary / primary):
 *   L2 = L3 = L1 x (N/2)^2
 *   M12 = k x sqrt(L1 x L2)
 *   M13 = k x sqrt(L1 x L3)  (= M12 for symmetric halves)
 *   M23 = k x sqrt(L2 x L3)  (= k x L2 for symmetric halves)
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
} from "../../core/registry.js";
import type { AnalogElementCore } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { InductorSubElement, MutualInductorElement } from "./mutual-inductor.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TAPPED_TRANSFORMER_PARAM_DEFS, defaults: TAPPED_TRANSFORMER_DEFAULTS } = defineModelParams({
  primary: {
    turnsRatio:          { default: 2.0,   description: "Total secondary to primary turns ratio N (both halves combined)", min: 0.001 },
    primaryInductance:   { default: 10e-3, unit: "H", description: "Primary winding self-inductance in henries", min: 1e-12 },
    couplingCoefficient: { default: 0.99,  description: "Magnetic coupling coefficient (0 = no coupling, 1 = ideal)", min: 0, max: 1 },
  },
  secondary: {
    primaryResistance:   { default: 0.0,   unit: "Ω", description: "Primary winding series resistance in ohms", min: 0 },
    secondaryResistance: { default: 0.0,   unit: "Ω", description: "Each secondary half winding series resistance in ohms", min: 0 },
  },
});

// ---------------------------------------------------------------------------
// State-pool schema — minimal composite (sub-elements own their state slots).
// Composite stores 6 flux-linkage read-back slots for getLteTimestep.
// ---------------------------------------------------------------------------

const TAPPED_TRANSFORMER_SCHEMA: StateSchema = defineStateSchema("AnalogTappedTransformerElement", [
  { name: "PHI1",  doc: "Total flux linkage winding 1 (mirror of L1 sub-element slot)", init: { kind: "zero" } },
  { name: "PHI2",  doc: "Total flux linkage winding 2 (mirror of L2 sub-element slot)", init: { kind: "zero" } },
  { name: "PHI3",  doc: "Total flux linkage winding 3 (mirror of L3 sub-element slot)", init: { kind: "zero" } },
]);

const SLOT_PHI1 = 0;
const SLOT_PHI2 = 1;
const SLOT_PHI3 = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTappedTransformerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "P1",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2",
      defaultBitWidth: 1,
      position: { x: 0, y: 4 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S1",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "CT",
      defaultBitWidth: 1,
      position: { x: 4, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S2",
      defaultBitWidth: 1,
      position: { x: 4, y: 4 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TappedTransformerElement  visual/editor representation
// ---------------------------------------------------------------------------

export class TappedTransformerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TappedTransformer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTappedTransformerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead lines: pin to coil edge
    ctx.drawLine(0, 0, 1.25, 0);      // P1 lead
    ctx.drawLine(0, 4, 1.25, 4);      // P2 lead
    ctx.drawLine(4, 0, 2.75, 0);      // S1 lead
    ctx.drawLine(4, 2, 2.75, 2);      // CT lead
    ctx.drawLine(4, 4, 2.75, 4);      // S2 lead

    // Primary coil: 6 right-facing arcs at x=1.25 (3π/2 to 5π/2) with vertical connectors
    const arcR = 5.333 / 16;
    for (let i = 0; i < 6; i++) {
      const cy = (i * 2 + 1) * arcR;
      ctx.drawArc(1.25, cy, arcR, 3 * Math.PI / 2, 5 * Math.PI / 2);
      ctx.drawLine(1.25, i * 2 * arcR, 1.25, (i + 1) * 2 * arcR);
    }

    // Secondary coil: 6 right-facing arcs at x=2.75 (3π/2 to 5π/2) with vertical connectors
    for (let i = 0; i < 6; i++) {
      const cy = (i * 2 + 1) * arcR;
      ctx.drawArc(2.75, cy, arcR, 3 * Math.PI / 2, 5 * Math.PI / 2);
      ctx.drawLine(2.75, i * 2 * arcR, 2.75, (i + 1) * 2 * arcR);
    }

    // Core lines (iron core between coils)
    ctx.drawLine(1.875, 0, 1.875, 4);
    ctx.drawLine(2.125, 0, 2.125, 4);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogTappedTransformerElement  MNA implementation
// ---------------------------------------------------------------------------

/**
 * MNA element for the three-winding center-tapped transformer.
 *
 * Composite: delegates to three InductorSubElement (L1, L2, L3) and three
 * MutualInductorElement (MUT12, MUT13, MUT23), all stored by ref.
 * setup() calls sub-elements in NGSPICE_LOAD_ORDER: INDs first, then MUTs.
 * load() delegates to sub-element load() methods.
 *
 * Node layout (pinNodeIds array positions):
 *   [0] = P1 (primary+)    [1] = P2 (primary-)
 *   [2] = S1 (sec-half-1+) [3] = CT (center tap)
 *   [4] = S2 (sec-half-2-)
 */
export class AnalogTappedTransformerElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  branchIndex: number = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = TAPPED_TRANSFORMER_SCHEMA;
  readonly stateSize = TAPPED_TRANSFORMER_SCHEMA.size;
  stateBaseOffset = -1;
  setParam(_key: string, _value: number): void {}

  readonly _l1: InductorSubElement;
  readonly _l2: InductorSubElement;
  readonly _l3: InductorSubElement;
  readonly _mut12: MutualInductorElement;
  readonly _mut13: MutualInductorElement;
  readonly _mut23: MutualInductorElement;

  private _pool!: StatePoolRef;

  constructor(
    pinNodeIds: number[],
    label: string,
    primaryInductance: number,
    turnsRatio: number,
    couplingCoefficient: number,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;

    const [p1Node, p2Node, s1Node, ctNode, s2Node] = pinNodeIds;

    const halfRatio = turnsRatio / 2;
    const l1 = primaryInductance;
    const l2 = primaryInductance * halfRatio * halfRatio;
    const l3 = primaryInductance * halfRatio * halfRatio;
    const k = couplingCoefficient;
    const m12 = k * Math.sqrt(l1 * l2);
    const m13 = k * Math.sqrt(l1 * l3);
    const m23 = k * Math.sqrt(l2 * l3);

    this._l1   = new InductorSubElement(p1Node, p2Node, label + "_L1", l1);
    this._l2   = new InductorSubElement(s1Node, ctNode, label + "_L2", l2);
    this._l3   = new InductorSubElement(ctNode, s2Node, label + "_L3", l3);

    this._mut12 = new MutualInductorElement(m12, this._l1, this._l2);
    this._mut13 = new MutualInductorElement(m13, this._l1, this._l3);
    this._mut23 = new MutualInductorElement(m23, this._l2, this._l3);
  }

  setup(ctx: SetupContext): void {
    // Composite setup: call sub-elements in NGSPICE_LOAD_ORDER — IND before MUT.
    // Order: L1, L2, L3 (INDs), then MUT12, MUT13, MUT23.
    // MUT setup reads li.branchIndex directly — no findDevice needed.

    this._l1.setup(ctx);   // indsetup.c pattern: allocStates(2) + makeCur + 5×allocElement
    this._l2.setup(ctx);   // indsetup.c pattern: allocStates(2) + makeCur + 5×allocElement
    this._l3.setup(ctx);   // indsetup.c pattern: allocStates(2) + makeCur + 5×allocElement

    // MUT instances require INDbrEq to be set on both inductors before calling setup.
    // Ordering invariant: all three IND setup() calls MUST complete before any MUT setup() call.
    // Each MutualInductorElement holds refs to its two inductors (stored at construction time).
    this._mut12.setup(ctx);  // mutsetup.c: 2×allocElement
    this._mut13.setup(ctx);  // mutsetup.c: 2×allocElement
    this._mut23.setup(ctx);  // mutsetup.c: 2×allocElement

    // Composite branchIndex mirrors the primary winding's branch row.
    this.branchIndex = this._l1.branchIndex;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(TAPPED_TRANSFORMER_SCHEMA, pool, this.stateBaseOffset, {});
  }

  load(ctx: LoadContext): void {
    this._l1.load(ctx);
    this._l2.load(ctx);
    this._l3.load(ctx);
    this._mut12.load(ctx);
    this._mut13.load(ctx);
    this._mut23.load(ctx);
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const dt1 = this._l1.getLteTimestep(dt, deltaOld, order, method, lteParams);
    const dt2 = this._l2.getLteTimestep(dt, deltaOld, order, method, lteParams);
    const dt3 = this._l3.getLteTimestep(dt, deltaOld, order, method, lteParams);
    return Math.min(dt1, dt2, dt3);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const i1 = rhs[this._l1.branchIndex]; // primary: P1-P2
    const i2 = rhs[this._l2.branchIndex]; // sec half-1: S1-CT
    const i3 = rhs[this._l3.branchIndex]; // sec half-2: CT-S2
    // pinLayout order: P1, P2, S1, CT, S2
    // CT: i2 exits (-i2) and i3 enters (+i3)  net = i3 - i2
    return [i1, -i1, i2, i3 - i2, -i3];
  }

}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function createTappedTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  let primaryInductance = props.getModelParam<number>("primaryInductance");
  let turnsRatio = props.getModelParam<number>("turnsRatio");
  let couplingCoefficient = props.getModelParam<number>("couplingCoefficient");

  const label = (props.has("label") ? props.getString("label") : "") || "TAPXFMR";

  const el = new AnalogTappedTransformerElement(
    [
      pinNodes.get("P1")!,
      pinNodes.get("P2")!,
      pinNodes.get("S1")!,
      pinNodes.get("CT")!,
      pinNodes.get("S2")!,
    ],
    label,
    primaryInductance,
    turnsRatio,
    couplingCoefficient,
  );
  el._pinNodes = new Map(pinNodes);

  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key === "primaryInductance") {
      primaryInductance = value;
      const halfRatio = turnsRatio / 2;
      const l2 = primaryInductance * halfRatio * halfRatio;
      const l3 = primaryInductance * halfRatio * halfRatio;
      el._l1.setParam("L", primaryInductance);
      el._l2.setParam("L", l2);
      el._l3.setParam("L", l3);
      el._mut12.setParam("coupling", couplingCoefficient * Math.sqrt(primaryInductance * l2));
      el._mut13.setParam("coupling", couplingCoefficient * Math.sqrt(primaryInductance * l3));
      el._mut23.setParam("coupling", couplingCoefficient * Math.sqrt(l2 * l3));
    } else if (key === "turnsRatio") {
      turnsRatio = value;
      const halfRatio = turnsRatio / 2;
      const l2 = primaryInductance * halfRatio * halfRatio;
      const l3 = primaryInductance * halfRatio * halfRatio;
      el._l2.setParam("L", l2);
      el._l3.setParam("L", l3);
      el._mut12.setParam("coupling", couplingCoefficient * Math.sqrt(primaryInductance * l2));
      el._mut13.setParam("coupling", couplingCoefficient * Math.sqrt(primaryInductance * l3));
      el._mut23.setParam("coupling", couplingCoefficient * Math.sqrt(l2 * l3));
    } else if (key === "couplingCoefficient") {
      couplingCoefficient = value;
      el._mut12.setParam("coupling", value);
      el._mut13.setParam("coupling", value);
      el._mut23.setParam("coupling", value);
    } else if (key === "K12") {
      el._mut12.setParam("coupling", value);
    } else if (key === "K13") {
      el._mut13.setParam("coupling", value);
    } else if (key === "K23") {
      el._mut23.setParam("coupling", value);
    } else if (key.startsWith("L1.")) {
      el._l1.setParam(key.slice(3), value);
    } else if (key.startsWith("L2.")) {
      el._l2.setParam(key.slice(3), value);
    } else if (key.startsWith("L3.")) {
      el._l3.setParam(key.slice(3), value);
    }
  };

  return el;
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TAPPED_TRANSFORMER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "primaryResistance",
    type: PropertyType.FLOAT,
    label: "Primary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 0.0,
    min: 0,
    description: "Primary winding series resistance in ohms",
  },
  {
    key: "secondaryResistance",
    type: PropertyType.FLOAT,
    label: "Secondary Resistance per Half (Ω)",
    unit: "Ω",
    defaultValue: 0.0,
    min: 0,
    description: "Each secondary half winding series resistance in ohms",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional component label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "turnsRatio", propertyKey: "turnsRatio", modelParam: true, convert: (v) => parseFloat(v) },
  {
    xmlName: "primaryInductance",
    propertyKey: "primaryInductance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "couplingCoefficient",
    propertyKey: "couplingCoefficient",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "primaryResistance",
    propertyKey: "primaryResistance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "secondaryResistance",
    propertyKey: "secondaryResistance",
    convert: (v) => parseFloat(v),
  },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// TappedTransformerDefinition
// ---------------------------------------------------------------------------

function tappedTransformerCircuitFactory(props: PropertyBag): TappedTransformerElement {
  return new TappedTransformerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TappedTransformerDefinition: ComponentDefinition = {
  name: "TappedTransformer",
  typeId: -1,
  factory: tappedTransformerCircuitFactory,
  pinLayout: buildTappedTransformerPinDeclarations(),
  propertyDefs: TAPPED_TRANSFORMER_PROPERTY_DEFS,
  attributeMap: TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Center-tapped three-winding transformer using 3×3 coupled inductor companion model.\n" +
    "Specify total turns ratio N, primary inductance, coupling coefficient k, and winding resistances.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTappedTransformerElement,
      paramDefs: TAPPED_TRANSFORMER_PARAM_DEFS,
      params: TAPPED_TRANSFORMER_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
  findBranchFor: (name: string, ctx: SetupContext, elements: ReadonlyMap<string, import("../../solver/analog/element.js").AnalogElement>) => {
    void elements;
    const el = elements.get(name);
    if (!el) return 0;
    const analog = el as unknown as AnalogTappedTransformerElement;
    if (!analog._l1 || !analog._l2 || !analog._l3) return 0;
    return analog._l1.findBranchFor(name, ctx)
      || analog._l2.findBranchFor(name, ctx)
      || analog._l3.findBranchFor(name, ctx);
  },
};
