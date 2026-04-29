/**
 * Shared fixture for LED analog tests.
 *
 * Builds a DC circuit: DcVoltageSource → Resistor → LED (anode) → GND (cathode
 * is hardwired to node 0 inside createLedAnalogElementViaDiode — the LED is a
 * single-pin circuit element at the netlist level).
 *
 * Using DefaultSimulatorFacade ensures the compiler runs its three color-preset
 * merge sites (compiler.ts stamp route, analog factory route, registry
 * createSeededBag), so the LED element sees IS/N from
 * LedDefinition.modelRegistry[color].params rather than DIODE_PARAM_DEFAULTS.
 */

import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

export function buildLedDcCircuit(opts: {
  color: "red" | "yellow" | "green" | "blue" | "white";
  vSupply: number;
  rSeries: number;
  TEMP?: number;
}) {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: opts.vSupply } },
      { id: "r1",  type: "Resistor",        props: { resistance: opts.rSeries } },
      {
        id: "led",
        type: "LED",
        props: {
          color: opts.color,
          label: "led",
          ...(opts.TEMP !== undefined ? { TEMP: opts.TEMP } : {}),
        },
      },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "r1:A"],
      ["r1:B",    "led:in"],
      ["vs:neg",  "gnd:out"],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { circuit, coordinator, facade };
}
