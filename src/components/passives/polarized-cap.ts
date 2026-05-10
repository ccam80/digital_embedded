/**
 * Polarized electrolytic capacitor analog component.
 *
 * Modeled as a 4-leaf MnaSubcircuitNetlist composed of canonical primitives:
 *   - rEsr   (Resistor)  : equivalent series resistance, pos ↔ nCap
 *   - rLeak  (Resistor)  : leakage path, nCap ↔ neg
 *   - cBody  (Capacitor) : body capacitance, nCap ↔ neg
 *   - dClamp (Diode)     : reverse-bias clamp, A=neg / K=pos (CJO=0, TT=0)
 *
 * Internal node `nCap` sits between ESR and the capacitor body — matching the
 * legacy inline element's _nCap topology. The four leaves expand into the
 * SPICE deck as ordinary R/C/D primitives so paired comparison against
 * ngspice succeeds without translation. rLeak is derived at netlist-build
 * time from voltageRating / leakageCurrent (function-form netlist).
 *
 * The reverse-bias-cap UI diagnostic is lifted to a parent-side observer
 * (`PolarizedCapDiagnosticObserver`) registered via `analogObservers` on the
 * standalone definition. It contributes nothing to MNA — it just reads
 * pos/neg node voltages each load() and emits the diagnostic when the
 * capacitor is reverse-biased beyond `reverseMax`.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
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
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { AnalogWrapperHook, AnalogWrapperHookFactory } from "../../core/registry.js";
import type { Diagnostic } from "../../compile/types.js";
import { defineModelParams } from "../../core/model-params.js";
import { DIODE_PARAM_DEFAULTS } from "../semiconductors/diode.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: POLARIZED_CAP_PARAM_DEFS, defaults: POLARIZED_CAP_MODEL_DEFAULTS } = defineModelParams({
  primary: {
    capacitance:    { default: 100e-6, unit: "F", description: "Capacitance in farads", min: 1e-12 },
    esr:            { default: 0.1,    unit: "Î", description: "Equivalent series resistance in ohms", min: 0 },
  },
  secondary: {
    leakageCurrent: { default: 1e-6,  unit: "A", description: "DC leakage current at rated voltage", min: 0 },
    voltageRating:  { default: 25,    unit: "V", description: "Maximum rated voltage", min: 1 },
    reverseMax:     { default: 1.0,   unit: "V", description: "Reverse voltage threshold that triggers a polarity warning", min: 0 },
    IC:             { default: 0,     unit: "V", description: "Initial condition: junction voltage for UIC (alias: initCond)" },
    M:              { default: 1,                description: "Parallel-element multiplicity (applied at stamp time)" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPolarizedCapPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// PolarizedCapElement  AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class PolarizedCapElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PolarizedCap", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPolarizedCapPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: 4,
      height: 1.5 + 1e-10,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");
    const hasVoltage = vPos !== undefined && vNeg !== undefined;

    const PX = 1 / 16;
    const plateOffset = 28 * PX;

    drawColoredLead(ctx, hasVoltage ? signals : undefined, vPos, 0, 0, plateOffset, 0);
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vNeg, 4, 0, 4 - plateOffset, 0);

    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(plateOffset, -0.75, plateOffset, 0.75);

    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(plateOffset, 0, 4 - plateOffset, 0, [
        { offset: 0, color: signals!.voltageColor(vPos) },
        { offset: 1, color: signals!.voltageColor(vNeg) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    const curvedPts: [number, number][] = [
      [2.5625, -0.75],
      [2.3125, -0.5625],
      [2.25, -0.3125],
      [2.25, -0.125],
      [2.25, 0.125],
      [2.25, 0.3125],
      [2.3125, 0.5625],
      [2.5625, 0.75],
    ];
    for (let i = 0; i < curvedPts.length - 1; i++) {
      ctx.drawLine(curvedPts[i][0], curvedPts[i][1], curvedPts[i + 1][0], curvedPts[i + 1][1]);
    }

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("+", 0.9375, 0.625, { horizontal: "center", vertical: "top" });

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1.6875, -0.875, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// POLARIZED_CAP_NETLIST_BUILDER  function-form MnaSubcircuitNetlist
// ---------------------------------------------------------------------------
//
// rLeak is derived from voltageRating / leakageCurrent at netlist-build time
// (the function-form netlist pattern, mirroring transformer.ts:186). The
// remaining sub-element params are string-resolved against the parent's
// model params via the standard SubcircuitElementParam mechanism.
//
// Topology (matches the legacy inline element's _nCap layout):
//   pos ─ rEsr ─ nCap ─ (cBody || rLeak) ─ neg
//   neg ─ dClamp(A=neg, K=pos) ─ pos        (reverse-bias clamp)

export const POLARIZED_CAP_NETLIST_BUILDER = (
  parentParams: PropertyBag,
): MnaSubcircuitNetlist => {
  const voltageRating = parentParams.hasModelParam("voltageRating")
    ? parentParams.getModelParam<number>("voltageRating")
    : POLARIZED_CAP_MODEL_DEFAULTS.voltageRating;
  const leakageCurrent = parentParams.hasModelParam("leakageCurrent")
    ? parentParams.getModelParam<number>("leakageCurrent")
    : POLARIZED_CAP_MODEL_DEFAULTS.leakageCurrent;
  const rLeak = leakageCurrent > 0 ? voltageRating / leakageCurrent : 1e12;

  return {
    ports: ["pos", "neg"],
    internalNetCount: 1,
    internalNetLabels: ["nCap"],
    params: { ...POLARIZED_CAP_MODEL_DEFAULTS, ...DIODE_PARAM_DEFAULTS, CJO: 0, TT: 0 },
    elements: [
      {
        typeId: "Resistor", modelRef: "behavioral", subElementName: "rEsr",
        params: { resistance: "esr" },
      },
      {
        typeId: "Resistor", modelRef: "behavioral", subElementName: "rLeak",
        params: { resistance: rLeak },
      },
      {
        typeId: "Capacitor", modelRef: "behavioral", subElementName: "cBody",
        params: { capacitance: "capacitance", IC: "IC", M: "M" },
      },
      {
        typeId: "Diode", modelRef: "spice", subElementName: "dClamp",
        // Diode params are passed as literal numbers from DIODE_PARAM_DEFAULTS
        // (with explicit CJO=0, TT=0 overrides) rather than string-lookups.
        // String-lookup form would route through parentProps first, and the
        // PolarizedCap parent has its own `M` (capacitor multiplicity) and
        // `IC` (cap initial voltage) which collide with diode `M` (grading
        // coefficient) and `IC` (junction initial voltage). Literal pass-
        // through bypasses parentProps and uses DIODE_PARAM_DEFAULTS directly,
        // matching the legacy clamp diode's makeClampDiodeProps factory.
        params: {
          ...DIODE_PARAM_DEFAULTS,
          CJO: 0,
          TT: 0,
        },
      },
    ],
    netlist: [
      [0, 2],   // rEsr:  pos=pos,  neg=nCap
      [2, 1],   // rLeak: pos=nCap, neg=neg
      [2, 1],   // cBody: pos=nCap, neg=neg
      [1, 0],   // dClamp: A=neg,   K=pos
    ],
  };
};

// ---------------------------------------------------------------------------
// PolarizedCap reverse-bias diagnostic  AnalogWrapperHook factory
// ---------------------------------------------------------------------------
//
// Hangs off the SubcircuitWrapperElement of each PolarizedCap instance via
// `analogWrapperHook` on the standalone definition. The wrapper is already
// in the engine's element walk; its load() forwards to this hook. The
// existing RuntimeDiagnosticAware wiring in MNAEngine.init() picks up the
// wrapper via setDiagnosticEmitter and threads the emitter through to the
// hook. No matrix or RHS contribution.
//
// State is closure-local: pos/neg node IDs captured at compile time,
// reverseMax mutable via setParam, edge-trigger flag prevents per-iteration
// duplicate emissions while voltage is below threshold.

const polarizedCapWrapperHook: AnalogWrapperHookFactory = (
  pinNodes,
  props,
): AnalogWrapperHook => {
  const nPos = pinNodes.get("pos");
  const nNeg = pinNodes.get("neg");
  let reverseMax = props.hasModelParam("reverseMax")
    ? props.getModelParam<number>("reverseMax")
    : POLARIZED_CAP_MODEL_DEFAULTS.reverseMax;
  let emit: (diag: Diagnostic) => void = () => {};
  let emitted = false;

  return {
    setDiagnosticEmitter(e: (diag: Diagnostic) => void): void {
      emit = e;
    },
    setParam(key: string, value: number): void {
      if (key === "reverseMax") reverseMax = value;
    },
    load(ctx: LoadContext): void {
      if (nPos === undefined || nNeg === undefined) return;
      const voltages = ctx.rhsOld;
      const vDiff = voltages[nPos] - voltages[nNeg];
      if (vDiff < -reverseMax) {
        if (!emitted) {
          emitted = true;
          emit({
            code: "reverse-biased-cap",
            severity: "warning",
            message: `Polarized capacitor reverse biased by ${(-vDiff).toFixed(2)} V (threshold: ${reverseMax} V)`,
            explanation:
              "Electrolytic capacitors are damaged by reverse bias. " +
              "Check circuit polarity and ensure the anode (positive terminal) " +
              "is at a higher potential than the cathode.",
            suggestions: [
              {
                text: "Reverse the capacitor polarity in the schematic.",
                automatable: false,
              },
            ],
          });
        }
      } else {
        emitted = false;
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POLARIZED_CAP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "leakageCurrent",
    type: PropertyType.FLOAT,
    label: "Leakage Current (A)",
    unit: "A",
    defaultValue: 1e-6,
    min: 0,
    description: "DC leakage current at rated voltage",
  },
  {
    key: "voltageRating",
    type: PropertyType.FLOAT,
    label: "Voltage Rating (V)",
    unit: "V",
    defaultValue: 25,
    min: 1,
    description: "Maximum rated voltage",
  },
  {
    key: "reverseMax",
    type: PropertyType.FLOAT,
    label: "Reverse Threshold (V)",
    unit: "V",
    defaultValue: 1.0,
    min: 0,
    description: "Reverse voltage threshold that triggers a polarity warning",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const POLARIZED_CAP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "capacitance",
    propertyKey: "capacitance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "esr",
    propertyKey: "esr",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "leakageCurrent",
    propertyKey: "leakageCurrent",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "voltageRating",
    propertyKey: "voltageRating",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "reverseMax",
    propertyKey: "reverseMax",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// PolarizedCapDefinition
// ---------------------------------------------------------------------------

function polarizedCapCircuitFactory(props: PropertyBag): PolarizedCapElement {
  return new PolarizedCapElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PolarizedCapDefinition: StandaloneComponentDefinition = {
  name: "PolarizedCap",
  typeId: -1,
  factory: polarizedCapCircuitFactory,
  pinLayout: buildPolarizedCapPinDeclarations(),
  propertyDefs: POLARIZED_CAP_PROPERTY_DEFS,
  attributeMap: POLARIZED_CAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Polarized electrolytic capacitor  extends the standard capacitor with ESR,\n" +
    "leakage current, and reverse-bias polarity enforcement.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: POLARIZED_CAP_NETLIST_BUILDER,
      paramDefs: POLARIZED_CAP_PARAM_DEFS,
      params: POLARIZED_CAP_MODEL_DEFAULTS,
    },
  },
  analogWrapperHook: polarizedCapWrapperHook,
  defaultModel: "behavioral",
};
