/**
 * RelayInductorSubElement- IND sub-element for relay coil.
 *
 * Thin adapter over AnalogInductorElement that maps the relay-parent's
 * local `L` model-param name to the base class's `inductance` key. All
 * MNA setup, branch allocation, state schema, and load() math is
 * inherited verbatim from AnalogInductorElement (ngspice indsetup.c +
 * indload.c parity).
 */

import { PropertyBag } from "../../core/properties.js";
import { AnalogInductorElement, INDUCTOR_DEFAULTS } from "../passives/inductor.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import type { AnalogElement } from "../../solver/analog/element.js";

export class RelayInductorSubElement extends AnalogInductorElement {
  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    const adapted = new PropertyBag();
    adapted.replaceModelParams({
      ...INDUCTOR_DEFAULTS,
      inductance: props.getModelParam<number>("L"),
    });
    super(pinNodes, adapted);
  }

  setParam(key: string, value: number): void {
    super.setParam(key === "L" ? "inductance" : key, value);
  }
}

const RELAY_INDUCTOR_PARAM_DEFS: ParamDef[] = [
  { key: "L", default: 1e-3 },
];

export const RelayInductorDefinition: ComponentDefinition = {
  name: "RelayInductor",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: RELAY_INDUCTOR_PARAM_DEFS,
      params: { L: 1e-3 },
      branchCount: 1,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new RelayInductorSubElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
