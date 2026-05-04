/**
 * DC Voltage Source  ideal independent voltage source for MNA simulation.
 *
 * Introduces one extra MNA branch row to enforce the voltage constraint.
 * Reads `ctx.srcFact` (ngspice CKTsrcFact) directly inside load() to apply
 * DC-OP source stepping  matches ngspice vsrcload.c:54 exactly.
 *
 * MNA stamp convention (1-based node IDs, solver uses 0-based):
 *   B[nodePos, k] += 1    C[k, nodePos] += 1
 *   B[nodeNeg, k] -= 1    C[k, nodeNeg] -= 1
 *   RHS[k]        += V * srcFact
 *
 * where k is the absolute branch row index in the MNA matrix.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import { PinDirection, type Pin, type PinDeclaration, type Rotation } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { MODEDCOP, MODEDCTRANCURVE, MODETRANOP } from "../../solver/analog/ckt-mode.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: DC_VOLTAGE_SOURCE_PARAM_DEFS, defaults: DC_VOLTAGE_SOURCE_DEFAULTS } = defineModelParams({
  primary: {
    voltage: { default: 5, unit: "V", description: "Source voltage in volts" },
  },
});

// ---------------------------------------------------------------------------
// DcVoltageSourceElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class DcVoltageSourceElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DcVoltageSource", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const decls = DC_VOLTAGE_SOURCE_PIN_LAYOUT;
    return this.derivePins(decls, []);
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
    const voltage = this._properties.getModelParam<number>("voltage");
    const label = this._visibleLabel();
    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");

    ctx.save();
    ctx.setLineWidth(1);

    // Lead from neg pin (x=0) to negative plate
    drawColoredLead(ctx, signals, vNeg, 0, 0, 1.75, 0);

    // Lead from pos pin (x=4) to positive plate
    drawColoredLead(ctx, signals, vPos, 2.25, 0, 4, 0);

    // Body (plates) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Shorter plate at x=1.75
    ctx.drawLine(1.75, 0.625, 1.75, -0.625);

    // Longer plate at x=2.25
    ctx.drawLine(2.25, 1, 2.25, -1);

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(voltage, "V") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 2, 1.25, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const DC_VOLTAGE_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
  {
    label: "neg",
    direction: PinDirection.OUTPUT,
    position: { x: 0, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    label: "pos",
    direction: PinDirection.INPUT,
    position: { x: 4, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DC_VOLTAGE_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label",
  },
];

// ---------------------------------------------------------------------------
// Attribute map
// ---------------------------------------------------------------------------

const DC_VOLTAGE_SOURCE_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Voltage", propertyKey: "voltage", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",   propertyKey: "label",   convert: (v) => v },
];

// ---------------------------------------------------------------------------
// DcVoltageSourceAnalogElement  AnalogElement class implementation
// ---------------------------------------------------------------------------

class DcVoltageSourceAnalogElement extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VSRC;

  private _voltage: number;

  // TSTALLOC handles — allocated in setup(), consumed by load().
  // Mirror ngspice VSRC instance pointers (vsrcset.c:52-55).
  private _hPosBr: number = -1;
  private _hNegBr: number = -1;
  private _hBrNeg: number = -1;
  private _hBrPos: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, voltage: number) {
    super(pinNodes);
    this._voltage = voltage;
  }

  setup(ctx: SetupContext): void {
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;

    // Port of vsrcset.c:40-43- idempotent branch allocation
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const k = this.branchIndex;

    // Port of vsrcset.c:52-55- TSTALLOC sequence (line-for-line)
    this._hPosBr = ctx.solver.allocElement(posNode, k);    // VSRCposNode, VSRCbranch
    this._hNegBr = ctx.solver.allocElement(negNode, k);    // VSRCnegNode, VSRCbranch
    this._hBrNeg = ctx.solver.allocElement(k, negNode);    // VSRCbranch,  VSRCnegNode
    this._hBrPos = ctx.solver.allocElement(k, posNode);    // VSRCbranch,  VSRCposNode
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    // Mirrors VSRCfindBr (vsrc/vsrcfbr.c:26-39).
    const dev = ctx.findDevice(name);
    if (!dev) return 0;
    if (dev.branchIndex === -1) {
      dev.branchIndex = ctx.makeCur(name, "branch");
    }
    return dev.branchIndex;
  }

  setParam(key: string, value: number): void {
    if (key === "voltage") this._voltage = value;
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    // vsrcload.c:43-46
    solver.stampElement(this._hPosBr, +1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrPos, +1.0);
    solver.stampElement(this._hBrNeg, -1.0);
    // ngspice srcFact gating: applied in MODEDCOP|MODEDCTRANCURVE (vsrcload.c:47-55)
    // and MODETRANOP (vsrcload.c:405-413). Outside these modes the source value
    // is applied directly. Match this gating; do not multiply unconditionally.
    const ramp = (ctx.cktMode & (MODEDCOP | MODEDCTRANCURVE | MODETRANOP))
      ? ctx.srcFact
      : 1.0;
    ctx.rhs[this.branchIndex] += this._voltage * ramp;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [-I, I];   // pinLayout order ["neg", "pos"]
  }
}

// ---------------------------------------------------------------------------
// makeDcVoltageSource- canonical inline-factory (ssA.13 / ssA.3: 3-arg form)
// ---------------------------------------------------------------------------

/**
 * Constructs a DC voltage source analog element.
 *
 * Canonical inline-factory pattern per ssA.13. Three-arg form per ssA.3.
 */
export function makeDcVoltageSource(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  return new DcVoltageSourceAnalogElement(pinNodes, props.getModelParam<number>("voltage"));
}

// ---------------------------------------------------------------------------
// StandaloneComponentDefinition
// ---------------------------------------------------------------------------

export const DcVoltageSourceDefinition: StandaloneComponentDefinition = {
  name: "DcVoltageSource",
  typeId: -1,
  category: ComponentCategory.SOURCES,

  pinLayout: DC_VOLTAGE_SOURCE_PIN_LAYOUT,
  propertyDefs: DC_VOLTAGE_SOURCE_PROPERTY_DEFS,
  attributeMap: DC_VOLTAGE_SOURCE_ATTRIBUTE_MAP,

  helpText: "Ideal DC voltage source. Introduces a branch current row in the MNA matrix.",

  factory(props: PropertyBag): DcVoltageSourceElement {
    return new DcVoltageSourceElement(
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      props,
    );
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: makeDcVoltageSource,
      paramDefs: DC_VOLTAGE_SOURCE_PARAM_DEFS,
      params: DC_VOLTAGE_SOURCE_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
