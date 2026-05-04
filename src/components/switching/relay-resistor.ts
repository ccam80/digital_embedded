/**
 * RelayResSubElement- RES sub-element for relay coil resistance.
 *
 * ngspice anchor: ressetup.c:46-49 (TSTALLOC) + resload.c (4-stamp conductance).
 */

import { AbstractAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

export class RelayResSubElement extends AbstractAnalogElement implements AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;

  // Handle fields- port of ressetup.c:46-49 TSTALLOC sequence
  _hPP: number = -1; // (RESposNode, RESposNode)
  _hNN: number = -1; // (RESnegNode, RESnegNode)
  _hPN: number = -1; // (RESposNode, RESnegNode)
  _hNP: number = -1; // (RESnegNode, RESposNode)

  private _resistance: number;
  private _G: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._resistance = Math.max(props.getModelParam<number>("R"), 1e-9);
    this._G = 1 / this._resistance;
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // ressetup.c:46-49: TSTALLOC sequence (4 entries, line-for-line)
    this._hPP = ctx.solver.allocElement(posNode, posNode); // (RESposNode, RESposNode)
    this._hNN = ctx.solver.allocElement(negNode, negNode); // (RESnegNode, RESnegNode)
    this._hPN = ctx.solver.allocElement(posNode, negNode); // (RESposNode, RESnegNode)
    this._hNP = ctx.solver.allocElement(negNode, posNode); // (RESnegNode, RESposNode)
  }

  load(ctx: LoadContext): void {
    // resload.c: stamp conductance through cached handles
    ctx.solver.stampElement(this._hPP, +this._G);
    ctx.solver.stampElement(this._hNN, +this._G);
    ctx.solver.stampElement(this._hPN, -this._G);
    ctx.solver.stampElement(this._hNP, -this._G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    const I = this._G * (rhs[posNode] - rhs[negNode]);
    return [I, -I];
  }

  setParam(key: string, value: number): void {
    if (key === "R") {
      this._resistance = Math.max(value, 1e-9);
      this._G = 1 / this._resistance;
    }
  }
}

const RELAY_RESISTOR_PARAM_DEFS: ParamDef[] = [
  { key: "R", default: 100 },
];

export const RelayResistorDefinition: ComponentDefinition = {
  name: "RelayResistor",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: RELAY_RESISTOR_PARAM_DEFS,
      params: { R: 100 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new RelayResSubElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
