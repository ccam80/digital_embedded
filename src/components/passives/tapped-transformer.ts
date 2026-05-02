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
 * Sub-element decomposition (netlist):
 *   L1  (subElementName: "L1"): Inductor- primary winding (P1 pos, P2 neg)
 *   L2  (subElementName: "L2"): Inductor- secondary half-1 (S1 pos, CT neg)
 *   L3  (subElementName: "L3"): Inductor- secondary half-2 (CT pos, S2 neg)
 *   MUT (subElementName: "MUT"): TransformerCoupling- coupling between L1, L2, L3
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";

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
    primaryResistance:   { default: 0.0,   unit: "Î©", description: "Primary winding series resistance in ohms", min: 0 },
    secondaryResistance: { default: 0.0,   unit: "Î©", description: "Each secondary half winding series resistance in ohms", min: 0 },
  },
});

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

    // Primary coil: 6 right-facing arcs at x=1.25 (3Ï€/2 to 5Ï€/2) with vertical connectors
    const arcR = 5.333 / 16;
    for (let i = 0; i < 6; i++) {
      const cy = (i * 2 + 1) * arcR;
      ctx.drawArc(1.25, cy, arcR, 3 * Math.PI / 2, 5 * Math.PI / 2);
      ctx.drawLine(1.25, i * 2 * arcR, 1.25, (i + 1) * 2 * arcR);
    }

    // Secondary coil: 6 right-facing arcs at x=2.75 (3Ï€/2 to 5Ï€/2) with vertical connectors
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
// buildTappedTransformerNetlist  function-form netlist (Composite M26)
// ---------------------------------------------------------------------------

/**
 * Builds the MNA subcircuit netlist for a three-winding center-tapped
 * transformer. Emits three Inductor leaves (L1, L2, L3) and one
 * TransformerCoupling element that stamps the mutual-inductance terms
 * across the coil branch indices resolved via siblingBranch.
 *
 * Port order: P1=0, P2=1, S1=2, CT=3, S2=4 (no internal nets).
 *
 * Inductance values derived from turnsRatio and primaryInductance:
 *   halfRatio = turnsRatio / 2
 *   L2 = L3 = primaryInductance * halfRatio^2
 */
export const buildTappedTransformerNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  const primaryInductance = params.getModelParam<number>("primaryInductance");
  const turnsRatio = params.getModelParam<number>("turnsRatio");
  const couplingCoefficient = params.getModelParam<number>("couplingCoefficient");

  const halfRatio = turnsRatio / 2;
  const l1 = primaryInductance;
  const l2 = primaryInductance * halfRatio * halfRatio;
  const l3 = primaryInductance * halfRatio * halfRatio;
  const k = couplingCoefficient;
  const m12 = k * Math.sqrt(l1 * l2);
  const m13 = k * Math.sqrt(l1 * l3);
  const m23 = k * Math.sqrt(l2 * l3);

  // Port indices: P1=0, P2=1, S1=2, CT=3, S2=4
  const ports = ["P1", "P2", "S1", "CT", "S2"];

  return {
    ports,
    elements: [
      {
        typeId: "Inductor",
        modelRef: "behavioral",
        subElementName: "L1",
        branchCount: 1,
        params: { L: l1 },
      } as unknown as import("../../core/mna-subcircuit-netlist.js").SubcircuitElement,
      {
        typeId: "Inductor",
        modelRef: "behavioral",
        subElementName: "L2",
        branchCount: 1,
        params: { L: l2 },
      } as unknown as import("../../core/mna-subcircuit-netlist.js").SubcircuitElement,
      {
        typeId: "Inductor",
        modelRef: "behavioral",
        subElementName: "L3",
        branchCount: 1,
        params: { L: l3 },
      } as unknown as import("../../core/mna-subcircuit-netlist.js").SubcircuitElement,
      // Pairwise TransformerCoupling — strict ngspice match. ngspice K elements
      // are 1-to-1 with coupled pairs; a 3-winding tapped transformer emits
      // K12 + K13 + K23. Each instance carries one M and two siblingBranch refs.
      {
        typeId: "TransformerCoupling",
        modelRef: "default",
        subElementName: "MUT12",
        params: {
          M: m12,
          L1_branch: { kind: "siblingBranch", subElementName: "L1" } as unknown as number,
          L2_branch: { kind: "siblingBranch", subElementName: "L2" } as unknown as number,
        },
      } as unknown as import("../../core/mna-subcircuit-netlist.js").SubcircuitElement,
      {
        typeId: "TransformerCoupling",
        modelRef: "default",
        subElementName: "MUT13",
        params: {
          M: m13,
          L1_branch: { kind: "siblingBranch", subElementName: "L1" } as unknown as number,
          L2_branch: { kind: "siblingBranch", subElementName: "L3" } as unknown as number,
        },
      } as unknown as import("../../core/mna-subcircuit-netlist.js").SubcircuitElement,
      {
        typeId: "TransformerCoupling",
        modelRef: "default",
        subElementName: "MUT23",
        params: {
          M: m23,
          L1_branch: { kind: "siblingBranch", subElementName: "L2" } as unknown as number,
          L2_branch: { kind: "siblingBranch", subElementName: "L3" } as unknown as number,
        },
      } as unknown as import("../../core/mna-subcircuit-netlist.js").SubcircuitElement,
    ],
    internalNetCount: 0,
    netlist: [
      [0, 1],  // L1: P1=0, P2=1
      [2, 3],  // L2: S1=2, CT=3
      [3, 4],  // L3: CT=3, S2=4
      [],      // MUT12: branch-only coupling
      [],      // MUT13: branch-only coupling
      [],      // MUT23: branch-only coupling
    ],
  };
};

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TAPPED_TRANSFORMER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "primaryResistance",
    type: PropertyType.FLOAT,
    label: "Primary Resistance (Î©)",
    unit: "Î©",
    defaultValue: 0.0,
    min: 0,
    description: "Primary winding series resistance in ohms",
  },
  {
    key: "secondaryResistance",
    type: PropertyType.FLOAT,
    label: "Secondary Resistance per Half (Î©)",
    unit: "Î©",
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

export const TappedTransformerDefinition: StandaloneComponentDefinition = {
  name: "TappedTransformer",
  typeId: -1,
  factory: tappedTransformerCircuitFactory,
  pinLayout: buildTappedTransformerPinDeclarations(),
  propertyDefs: TAPPED_TRANSFORMER_PROPERTY_DEFS,
  attributeMap: TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Center-tapped three-winding transformer using 3Ã—3 coupled inductor companion model.\n" +
    "Specify total turns ratio N, primary inductance, coupling coefficient k, and winding resistances.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: buildTappedTransformerNetlist,
      paramDefs: TAPPED_TRANSFORMER_PARAM_DEFS,
      params: TAPPED_TRANSFORMER_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
