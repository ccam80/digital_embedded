/**
 * BehavioralLogicDefinition — internal driver leaf backed by the I-mode
 * B-source (`BI`) device. The behavioural combinational/sequential logic of a
 * gate, mux, decoder, etc. is expressed as a B-source current expression over
 * its controller inputs (e.g. AND = `min(V(r1), V(r2))`, MUX =
 * `max(min(V(sel),V(d1)), min(1-V(sel),V(d0)))`). Because `BI` evaluates the
 * parse tree's analytic partials and stamps the full Jacobian (asrcload.c), the
 * coupled behavioural chain is a true Newton device and converges to its exact
 * fixed point in one iteration — unlike a constant-source Norton read from
 * rhsOld, which lags one iteration per chain stage. Emitting the same B-source
 * to ngspice makes these elements harness-comparable and bit-exact.
 *
 * I-mode (current source) + a parent-supplied 1Ω resistor forms a Norton:
 * with the parent wiring `out+ → gnd` and `out- → logicOut`, asrcload's
 * `rhs[neg] += expr` injects `+expr` into logicOut and the 1Ω resistor gives
 * `V(logicOut) = expr` — the exact `stampNortonValue(rOut=1)` the bespoke
 * drivers used, so it is behaviour-preserving, adds no branch row, and does not
 * trip the stiff-voltage-source diagnostics.
 *
 * Controllers bind by PIN: the pin layout derives one input pin per distinct
 * `V(label)` in the expression (first-encounter order), and `BIAnalogElement`
 * resolves each controller against `pinNodes` (bsource.ts `_resolveVarRow`),
 * so the parent subcircuit wires controllers by ordinary pin connectivity. Pin
 * order is `[controller pins…, out+, out-]`; the parent's netlist row MUST list
 * the controller nets in first-encounter order, then gnd (out+), then logicOut
 * (out-), and pair the element with a 1Ω resistor from logicOut to gnd.
 */

import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import type { PropertyBag } from "../../../core/properties.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import {
  BIAnalogElement,
  BI_PARAM_DEFS,
  BI_DEFAULTS,
} from "../../../components/active/bsource.js";
import { buildBSourceTree } from "../expression.js";

function controllerPins(expression: string): PinDeclaration[] {
  const tree = buildBSourceTree(expression);
  const decls: PinDeclaration[] = [];
  for (const v of tree.vars) {
    if (v.kind !== "node") continue;
    decls.push({
      direction: PinDirection.INPUT, label: v.label,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  return decls;
}

function buildBehavioralLogicPinLayout(props: PropertyBag): PinDeclaration[] {
  const expression = props.getOrDefault<string>("expression", "0");
  const decls = controllerPins(expression);
  decls.push({
    direction: PinDirection.OUTPUT, label: "out+",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  decls.push({
    direction: PinDirection.OUTPUT, label: "out-",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  return decls;
}

export const BehavioralLogicDefinition: ComponentDefinition = {
  name: "BehavioralLogic",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildBehavioralLogicPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: BI_PARAM_DEFS,
      params: BI_DEFAULTS,
      // Builds a BIAnalogElement (ASRC device); only its two output nodes are
      // deck tokens — controllers are V(node) references resolved from the
      // expression, not node tokens.
      spice: { device: "ASRC", deckNodeTokens: ["out+", "out-"] },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) => {
        const expression = props.getOrDefault<string>("expression", "0");
        const el = new BIAnalogElement(pinNodes, buildBSourceTree(expression));
        el.seedParams(props);
        return el;
      },
    },
  },
  defaultModel: "default",
};
