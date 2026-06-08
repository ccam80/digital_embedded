/**
 * Two-winding transformer component.
 *
 * Sub-element decomposition (netlist):
 *   L1  (subElementName: "L1"): Inductor — primary winding (P1 pos, P2 neg)
 *   L2  (subElementName: "L2"): Inductor — secondary winding (S1 pos, S2 neg)
 *   MUT (subElementName: "MUT"): MutualInductor — mutual coupling K(L1,L2)
 *
 * Pin layout (4 physical terminals):
 *   P1   primary positive
 *   P2   primary negative
 *   S1   secondary positive
 *   S2   secondary negative
 *
 * Inductance derivation for turns ratio N (secondary / primary):
 *   L_secondary = L_primary / N²    (digiTS convention: N = output/input)
 *   M           = k · √(L_primary · L_secondary) = k · L_primary / N
 *
 * ngspice anchors:
 *   indsetup.c:84-100 — IND branch allocation and TSTALLOC sequence
 *   mutsetup.c:30-70  — MUT branch resolution and TSTALLOC sequence
 *   indload.c         — IND load (companion model)
 *   mutload.c         — MUT load (off-diagonal coupling stamps)
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRANSFORMER_PARAM_DEFS, defaults: TRANSFORMER_DEFAULTS } = defineModelParams({
  primary: {
    turnsRatio:          { default: 1.0,   description: "Secondary to primary turns ratio N (output/input)", min: 0.001 },
    primaryInductance:   { default: 10e-3, unit: "H", description: "Primary winding self-inductance in henries", min: 1e-12 },
    couplingCoefficient: { default: 0.99,  description: "Magnetic coupling coefficient (0 = no coupling, 1 = ideal)", min: 0, max: 1 },
  },
  secondary: {
    primaryResistance:   { default: 1.0,   unit: "Ω", description: "Primary winding series resistance in ohms", min: 0 },
    secondaryResistance: { default: 1.0,   unit: "Ω", description: "Secondary winding series resistance in ohms", min: 0 },
    IC1:  { default: NaN, unit: "A", description: "Initial condition current for primary winding (UIC)" },
    IC2:  { default: NaN, unit: "A", description: "Initial condition current for secondary winding (UIC)" },
    M:    { default: 1,               description: "Parallel multiplicity factor (applied at stamp time per indload.c:41,107)" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTransformerPinDeclarations(): PinDeclaration[] {
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
      position: { x: 0, y: 2 },
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
      label: "S2",
      defaultBitWidth: 1,
      position: { x: 4, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TransformerElement — CircuitElement (visual/editor representation)
// ---------------------------------------------------------------------------

export class TransformerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Transformer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTransformerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const r = 5.333333 / 16;
    const arcStart = (3 * Math.PI) / 2;
    const arcEnd   = (5 * Math.PI) / 2;

    ctx.drawLine(0, 0, 21 / 16, 0);
    ctx.drawLine(4, 0, 43 / 16, 0);
    ctx.drawLine(0, 2, 21 / 16, 2);
    ctx.drawLine(4, 2, 43 / 16, 2);

    const coilCy = [5.333333 / 16, 16 / 16, 26.666667 / 16];
    const segY = [0, 10.666667 / 16, 21.333333 / 16, 2];

    const priCx = 21 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(priCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(priCx, segY[i], priCx, segY[i + 1]);
    }

    const secCx = 43 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(secCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(secCx, segY[i], secCx, segY[i + 1]);
    }

    ctx.drawLine(30 / 16, 0, 30 / 16, 2);
    ctx.drawLine(34 / 16, 0, 34 / 16, 2);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// buildTransformerNetlist — function-form netlist
// ---------------------------------------------------------------------------

/**
 * Builds the MNA subcircuit netlist for a two-winding transformer. Emits two
 * Inductor leaves (L1, L2) and one MutualInductor element that stamps
 * the mutual-inductance off-diagonals across the coil branch indices
 * resolved via `{ kind: "ref", name }`.
 *
 * Port order: P1=0, P2=1, S1=2, S2=3 (no internal nets).
 *
 * Inductance values derived from turnsRatio and primaryInductance:
 *   L1 = primaryInductance
 *   L2 = primaryInductance / turnsRatio²
 *   M  = couplingCoefficient · √(L1 · L2)
 */
export const buildTransformerNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  const primaryInductance = params.getModelParam<number>("primaryInductance");
  const turnsRatio = params.getModelParam<number>("turnsRatio");
  const couplingCoefficient = params.getModelParam<number>("couplingCoefficient");

  const l1 = primaryInductance;
  const l2 = primaryInductance / (turnsRatio * turnsRatio);

  // Port indices: P1=0, P2=1, S1=2, S2=3
  const ports = ["P1", "P2", "S1", "S2"];

  return {
    ports,
    elements: [
      {
        typeId: "Inductor",
        modelRef: "behavioral",
        subElementName: "L1",
        branchCount: 1,
        params: { inductance: l1 },
      },
      {
        typeId: "Inductor",
        modelRef: "behavioral",
        subElementName: "L2",
        branchCount: 1,
        params: { inductance: l2 },
      },
      // K-coupling — strict ngspice match. ngspice K elements are 1-to-1
      // with coupled pairs (mutsetup.c:66-67, mutload.c). Partner inductor
      // refs use `{ kind: "ref", name }`; MutualInductorElement.setup()
      // resolves them via ctx.findDevice (CKTfndDev pattern). K =
      // couplingCoefficient; MUTfactor = K·√(L1·L2) is computed in setup()
      // from live partner inductances.
      {
        typeId: "MutualInductor",
        modelRef: "default",
        subElementName: "MUT",
        params: {
          K: couplingCoefficient,
          L1_branch: { kind: "ref", name: "L1" },
          L2_branch: { kind: "ref", name: "L2" },
        },
      },
    ],
    internalNetCount: 0,
    netlist: [
      [0, 1],  // L1: P1=0, P2=1
      [2, 3],  // L2: S1=2, S2=3
      [],      // MUT: branch-only coupling
    ],
  };
};

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRANSFORMER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "primaryResistance",
    type: PropertyType.FLOAT,
    label: "Primary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 1.0,
    min: 0,
    description: "Primary winding series resistance in ohms",
  },
  {
    key: "secondaryResistance",
    type: PropertyType.FLOAT,
    label: "Secondary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 1.0,
    min: 0,
    description: "Secondary winding series resistance in ohms",
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

export const TRANSFORMER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
// TransformerDefinition
// ---------------------------------------------------------------------------

function transformerCircuitFactory(props: PropertyBag): TransformerElement {
  return new TransformerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TransformerDefinition: StandaloneComponentDefinition = {
  name: "Transformer",
  typeId: -1,
  factory: transformerCircuitFactory,
  pinLayout: buildTransformerPinDeclarations(),
  voltageProbes: [
    { name: "Vp", pos: "P1", neg: "P2" },
    { name: "Vs", pos: "S1", neg: "S2" },
  ],
  propertyDefs: TRANSFORMER_PROPERTY_DEFS,
  attributeMap: TRANSFORMER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Two-winding transformer using coupled inductor companion model.\n" +
    "Specify turns ratio N, primary inductance, coupling coefficient k, and winding resistances.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: buildTransformerNetlist,
      paramDefs: TRANSFORMER_PARAM_DEFS,
      params: TRANSFORMER_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
