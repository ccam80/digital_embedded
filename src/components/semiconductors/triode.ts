/**
 * Triode vacuum tube analog component- Koren model.
 *
 * The Koren model is the standard for audio amplifier simulation. The plate
 * current depends on both plate voltage and grid voltage via:
 *
 *   E1 = V_PK / K_P · ln(1 + exp(K_P · (1/µ + V_GK / sqrt(K_VB + V_PK²))))
 *   I_P = (E1 / K_G1)^EX   when E1 > 0, else 0
 *
 * The triode is a three-terminal device:
 *   pinNodes.get("P") = plate / anode
 *   pinNodes.get("G") = grid
 *   pinNodes.get("K") = cathode
 *
 * Topology (netlist form): one `TriodeAnalog` internal-only sub-element
 * carrying all 6 stamps and the Koren NR linearisation. The parent here is
 * the editor / property-bag façade; the simulation behaviour lives in
 * `triode-analog-element.ts`.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
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
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRIODE_PARAM_DEFS, defaults: TRIODE_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    mu:  { default: 100,  description: "Amplification factor µ" },
    kp:  { default: 600,  description: "Koren K_P parameter controlling plate-voltage sensitivity" },
    kg1: { default: 1060, description: "Koren K_G1 transconductance scaling factor" },
  },
  secondary: {
    kvb: { default: 300,  description: "Koren K_VB parameter (V²) for grid-plate interaction" },
    ex:  { default: 1.4,  description: "Koren current exponent EX" },
    rGI: { default: 2000, unit: "Ω", description: "Grid input resistance (limits grid current when V_GK > 0)" },
  },
});

// ---------------------------------------------------------------------------
// buildTriodeNetlist- function-form netlist
// ---------------------------------------------------------------------------

/**
 * Builds the MNA subcircuit netlist for a triode vacuum tube. Emits a single
 * `TriodeAnalog` internal-only sub-element carrying the Koren two-voltage
 * nonlinearity (gm + gds linearisation, V_GK step limiting, BJTconvTest-style
 * cphat convergence). All Koren params (mu, kp, kvb, kg1, ex, rGI) flow
 * through the sub-element's params bag via string-key lookups into the
 * parent's resolved subcircuit-level params.
 *
 * Port order: P=0, G=1, K=2 (no internal nets).
 */
export const buildTriodeNetlist = (_params: PropertyBag): MnaSubcircuitNetlist => {
  return {
    ports: ["P", "G", "K"],
    params: { ...TRIODE_PARAM_DEFAULTS },
    elements: [
      {
        typeId: "TriodeAnalog",
        modelRef: "default",
        subElementName: "Q",
        params: {
          mu:  "mu",
          kp:  "kp",
          kvb: "kvb",
          kg1: "kg1",
          ex:  "ex",
          rGI: "rGI",
        },
      },
    ],
    internalNetCount: 0,
    netlist: [
      [0, 1, 2],  // TriodeAnalog: P=0, G=1, K=2
    ],
  };
};

// ---------------------------------------------------------------------------
// TriodeCircuitElement- AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class TriodeCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Triode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTriodePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 5.5,
      height: 4.0,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // All coordinates in grid units (Falstad pixels ÷ 16)
    // Reference: TriodeElm in fixtures/falstad-shapes.json
    // Origin: G pin at (0, 0), point2 at (4, 0)

    // Envelope circle: center (4, 0), r = 23.52/16 ≈ 1.47
    ctx.drawCircle(4.0, 0.0, 23.52 / 16, false);

    // Plate lead: (4, -2) → (4, -0.5)
    ctx.drawLine(4.0, -2.0, 4.0, -0.5);

    // Plate bar: (2.875, -0.5) → (5.125, -0.5)
    ctx.drawLine(2.875, -0.5, 5.125, -0.5);

    // Grid lead: (0, 0) → (2.5, 0)
    ctx.drawLine(0.0, 0.0, 2.5, 0.0);

    // Grid dashes (3 segments)
    ctx.drawLine(2.8125, 0.0, 3.1875, 0.0);
    ctx.drawLine(3.8125, 0.0, 4.1875, 0.0);
    ctx.drawLine(4.8125, 0.0, 5.1875, 0.0);

    // Cathode vertical: (3, 2) → (3, 0.5)
    ctx.drawLine(3.0, 2.0, 3.0, 0.5);

    // Cathode horizontal: (3, 0.5) → (5, 0.5)
    ctx.drawLine(3.0, 0.5, 5.0, 0.5);

    // Cathode stub: (5, 0.5) → (5, 0.625)
    ctx.drawLine(5.0, 0.5, 5.0, 0.625);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTriodePinDeclarations(): PinDeclaration[] {
  // currentLead waypoints route each terminal to the device body junction at x≈2.
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "P",
      defaultBitWidth: 1,
      position: { x: 4, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
      currentLead: [{ x: 2, y: -1 }],
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
      currentLead: [{ x: 2, y: 0 }],
    },
    {
      direction: PinDirection.INPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 3, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
      currentLead: [{ x: 2, y: 1 }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRIODE_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRIODE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// StandaloneComponentDefinition
// ---------------------------------------------------------------------------

function triodeCircuitFactory(props: PropertyBag): TriodeCircuitElement {
  return new TriodeCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TriodeDefinition: StandaloneComponentDefinition = {
  name: "Triode",
  typeId: -1,
  pairedSpiceEquivalent: false,
  factory: triodeCircuitFactory,
  pinLayout: buildTriodePinDeclarations(),
  voltageProbes: [
    { name: "Vpk", pos: "P", neg: "K" },
    { name: "Vgk", pos: "G", neg: "K" },
  ],
  propertyDefs: TRIODE_PROPERTY_DEFS,
  attributeMap: TRIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Triode vacuum tube- Koren model.\n" +
    "Pins: P (plate), G (grid), K (cathode).\n" +
    "Standard 12AX7 defaults: µ=100, K_P=600, K_VB=300, K_G1=1060, EX=1.4.",
  models: {},
  modelRegistry: {
    "koren": {
      kind: "netlist",
      netlist: buildTriodeNetlist,
      paramDefs: TRIODE_PARAM_DEFS,
      params: TRIODE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "koren",
};
