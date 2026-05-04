/**
 * Optocoupler (opto-isolator) analog component.
 *
 * Architecture: declarative netlist composing LED diode, 0V sense source,
 * CCCS coupling, and phototransistor. Galvanic isolation between the input
 * (anode/cathode) and output (collector/emitter) ports- the CCCS coupling
 * is algebraic only.
 *
 * Pins: anode, cathode, collector, emitter.
 * Internal nets: senseMid (LED cathode / sense pos), base (phototransistor base).
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
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: OPTOCOUPLER_PARAM_DEFS, defaults: OPTOCOUPLER_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    ctr: { default: 1.0,   description: "Current transfer ratio CTR = I_collector / I_LED" },
    Is:  { default: 1e-14, unit: "A", description: "LED saturation current (dioload.c IS)" },
    n:   { default: 1.0,              description: "LED emission coefficient (dioload.c N)" },
  },
});

// ---------------------------------------------------------------------------
// OPTOCOUPLER_NETLIST- declarative composite (Composite M4)
//
// Ports: [anode, cathode, collector, emitter]      (indices 0..3)
// Internal nets: senseMid (4), base (5)
// ---------------------------------------------------------------------------

export const OPTOCOUPLER_NETLIST: MnaSubcircuitNetlist = {
  ports: ["anode", "cathode", "collector", "emitter"],
  params: { ctr: 1.0, Is: 1e-14, n: 1.0 },
  elements: [
    { typeId: "Diode",                 modelRef: "spice",   subElementName: "dLed",       params: { IS: "Is", N: "n" } },
    { typeId: "InternalZeroVoltSense", modelRef: "default", subElementName: "vSense",     branchCount: 1 },
    { typeId: "InternalCccs",          modelRef: "default", subElementName: "cccsCouple",
      params: { gain: "ctr", sense: { kind: "siblingBranch", subElementName: "vSense" } } },
    { typeId: "NpnBJT",                modelRef: "spice",   subElementName: "bjtPhoto" },
  ],
  internalNetCount: 2,
  internalNetLabels: ["senseMid", "base"],
  netlist: [
    [0, 4],        // dLed: A=anode, K=senseMid
    [4, 1],        // vSense: pos=senseMid, neg=cathode
    [5, 3],        // cccsCouple: pos=base, neg=emitter
    [5, 2, 3],     // bjtPhoto: B=base, C=collector, E=emitter
  ],
};

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOptocouplerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "anode",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "cathode",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "collector",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "emitter",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// OptocouplerElement- CircuitElement
// ---------------------------------------------------------------------------

export class OptocouplerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Optocoupler", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildOptocouplerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const PX = 1 / 16;

    const vAnode     = signals?.getPinVoltage("anode");
    const vCathode   = signals?.getPinVoltage("cathode");
    const vCollector = signals?.getPinVoltage("collector");
    const vEmitter   = signals?.getPinVoltage("emitter");

    ctx.save();
    ctx.setLineWidth(1);

    ctx.setColor("COMPONENT");
    ctx.drawRect(0, -2, 4, 4, false);
    ctx.drawLine(2, -2, 2, 2);

    const ledHs = 8 * PX;
    const triTop  = { x: 0.5, y: -ledHs };
    const triBtm  = { x: 0.5, y: ledHs };
    const triTip  = { x: 1.5, y: 0 };
    ctx.drawPolygon([triTop, triBtm, triTip], false);
    ctx.drawLine(triTip.x - ledHs, triTip.y + ledHs,
                 triTip.x + ledHs, triTip.y - ledHs);

    for (let i = 0; i < 2; i++) {
      const ay = -0.2 + i * 0.4;
      const aBase = { x: 1.7, y: ay };
      const aTip = { x: 2.1, y: ay - 0.3 };
      const dx = aTip.x - aBase.x;
      const dy = aTip.y - aBase.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const al = 5 * PX;
      const aw = 3 * PX;
      const f = 1 - al / len;
      const cx = aBase.x * (1 - f) + aTip.x * f;
      const cy = aBase.y * (1 - f) + aTip.y * f;
      const gx = (dy / len) * aw;
      const gy = (-dx / len) * aw;
      ctx.drawPolygon(
        [{ x: aTip.x, y: aTip.y }, { x: cx + gx, y: cy + gy }, { x: cx - gx, y: cy - gy }],
        true,
      );
      ctx.drawLine(aBase.x, aBase.y, aTip.x - 5 * PX * 0.7, aTip.y + 5 * PX * 0.7);
    }

    ctx.drawCircle(3, 0, 0.7, false);
    ctx.drawLine(2.75, -0.5, 2.75, 0.5);
    ctx.drawLine(2, 0, 2.75, 0);

    const emDx = 4 - 2.75;
    const emDy = 1 - 0.5;
    const emLen = Math.sqrt(emDx * emDx + emDy * emDy);
    const emAl = 8 * PX;
    const emAw = 3 * PX;
    const emF = 1 - emAl / emLen;
    const emCx = 2.75 * (1 - emF) + 4 * emF;
    const emCy = 0.5 * (1 - emF) + 1 * emF;
    const emGx = (emDy / emLen) * emAw;
    const emGy = (-emDx / emLen) * emAw;
    ctx.drawPolygon(
      [{ x: 4, y: 1 }, { x: emCx + emGx, y: emCy + emGy }, { x: emCx - emGx, y: emCy - emGy }],
      true,
    );

    drawColoredLead(ctx, signals, vAnode, 0, -1, triTop.x, triTop.y);
    drawColoredLead(ctx, signals, vCathode, 0, 1, triBtm.x, triBtm.y);
    drawColoredLead(ctx, signals, vCollector, 2.75, -0.5, 4, -1);
    drawColoredLead(ctx, signals, vEmitter, 2.75, 0.5, 4, 1);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("A", 0.15, -1.4, { horizontal: "left", vertical: "bottom" });
    ctx.drawText("K", 0.15, 1.4, { horizontal: "left", vertical: "top" });
    ctx.drawText("C", 3.85, -1.4, { horizontal: "right", vertical: "bottom" });
    ctx.drawText("E", 3.85, 1.4, { horizontal: "right", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OPTOCOUPLER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "vceSat",
    type: PropertyType.FLOAT,
    label: "V_CE saturation (V)",
    defaultValue: 0.3,
    min: 0,
    description: "Phototransistor saturation voltage V_CE in volts. Default: 0.3 V.",
  },
  {
    key: "bandwidth",
    type: PropertyType.FLOAT,
    label: "Bandwidth (Hz)",
    defaultValue: 50000,
    min: 1,
    description: "Optocoupler bandwidth in Hz. Default: 50 kHz.",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const OPTOCOUPLER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "ctr",       propertyKey: "ctr",       convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Is",        propertyKey: "Is",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "n",         propertyKey: "n",          convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vceSat",    propertyKey: "vceSat",     convert: (v) => parseFloat(v) },
  { xmlName: "bandwidth", propertyKey: "bandwidth",  convert: (v) => parseFloat(v) },
  { xmlName: "Label",     propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// OptocouplerDefinition
// ---------------------------------------------------------------------------

export const OptocouplerDefinition: StandaloneComponentDefinition = {
  name: "Optocoupler",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildOptocouplerPinDeclarations(),
  propertyDefs: OPTOCOUPLER_PROPERTY_DEFS,
  attributeMap: OPTOCOUPLER_ATTRIBUTE_MAPPINGS,

  helpText:
    "Optocoupler- 4-terminal element (anode, cathode, collector, emitter). " +
    "LED input (dioload.c) + 0V sense source (vsrcload.c) + CCCS coupling (CTR) + phototransistor output (bjtload.c). " +
    "I_collector â‰ˆ CTR * I_LED. Galvanic isolation between LED and phototransistor.",

  factory(props: PropertyBag): OptocouplerElement {
    return new OptocouplerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "default": {
      kind: "netlist",
      netlist: OPTOCOUPLER_NETLIST,
      paramDefs: OPTOCOUPLER_PARAM_DEFS,
      params: OPTOCOUPLER_PARAM_DEFAULTS,
    },
  },
  defaultModel: "default",
};
