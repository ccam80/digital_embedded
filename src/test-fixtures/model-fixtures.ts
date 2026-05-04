import { PropertyBag } from "../core/properties.js";
import { defineModelParams } from "../core/model-params.js";
import type { AnalogFactory, ModelEntry } from "../core/registry.js";
import { AnalogElement } from "../solver/analog/element.js";
import type { SetupContext } from "../solver/analog/setup-context.js";
import type { LoadContext } from "../solver/analog/load-context.js";

class StubAnalogElement extends AnalogElement {
  readonly ngspiceLoadOrder = 0;
  setup(_ctx: SetupContext): void {}
  load(_ctx: LoadContext): void {}
  getPinCurrents(_rhs: Float64Array): number[] { return []; }
  setParam(_key: string, _value: number): void {}
}

/**
 * Stub AnalogFactory that returns a minimal AnalogElement.
 * For use in tests that need a valid factory reference without real MNA logic.
 */
export const STUB_ANALOG_FACTORY: AnalogFactory = (
  pinNodes,
  _props,
  _getTime,
) => new StubAnalogElement(pinNodes);

/**
 * Sample param definitions for a resistor-like component.
 */
export const { paramDefs: RESISTOR_PARAM_DEFS, defaults: RESISTOR_DEFAULTS } = defineModelParams({
  primary: {
    resistance: { default: 1000, unit: "\u03A9", description: "Resistance value" },
  },
});

/**
 * Sample param definitions for a BJT-like component with primary and secondary params.
 */
export const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_DEFAULTS } = defineModelParams({
  primary: {
    BF: { default: 100, description: "Forward current gain" },
    IS: { default: 1e-14, unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF: { default: 1, description: "Forward emission coefficient" },
    BR: { default: 1, description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
  },
});

/**
 * Sample inline ModelEntry for a resistor-like component.
 */
export const RESISTOR_MODEL_ENTRY: ModelEntry = {
  kind: "inline",
  factory: STUB_ANALOG_FACTORY,
  paramDefs: RESISTOR_PARAM_DEFS,
  params: RESISTOR_DEFAULTS,
};

/**
 * Sample inline ModelEntry for a BJT-like component.
 */
export const BJT_MODEL_ENTRY: ModelEntry = {
  kind: "inline",
  factory: STUB_ANALOG_FACTORY,
  paramDefs: BJT_PARAM_DEFS,
  params: BJT_DEFAULTS,
};

/**
 * Create a fresh PropertyBag with optional static entries pre-populated.
 */
export function createTestPropertyBag(
  staticEntries?: Record<string, number | string | boolean>,
): PropertyBag {
  const entries: [string, number | string | boolean][] = staticEntries
    ? Object.entries(staticEntries)
    : [];
  return new PropertyBag(entries);
}
