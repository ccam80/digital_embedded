/**
 * Loads the generated DSL spike .dts through the deserializer to surface
 * any runtime errors before the user attempts to load it in the browser.
 */

import { readFileSync } from "node:fs";
import { createDefaultRegistry } from "../src/components/register-all.js";
import { deserializeDts } from "../src/io/dts-deserializer.js";
import { DefaultSimulatorFacade } from "../src/headless/default-facade.js";

const json = readFileSync("circuits/sar_adc_4bit_from_dsl.dts", "utf-8");
const registry = createDefaultRegistry();

try {
  const circuit = deserializeDts(json, registry);
  console.log(
    `Deserialize OK — elements: ${circuit.elements.length}, wires: ${circuit.wires.length}`,
  );

  // Try resolving pins for every element (this exercises the same code paths
  // the renderer hits and is where pin-position bugs typically surface).
  for (const el of circuit.elements) {
    try {
      const pins = el.getPins();
      const bbox = el.getBoundingBox();
      // Touch each pin's position to trigger any lazy errors
      for (const p of pins) {
        if (p.position === undefined) {
          throw new Error(`pin "${p.label}" has undefined position`);
        }
        const _ = p.position.x + p.position.y;
      }
      void bbox;
    } catch (e) {
      console.log(
        `Element ${el.constructor.name} typeId=${el.typeId} label=${el.properties?.getOrDefault?.("label", "?")} FAILED: ${e instanceof Error ? e.message : e}`,
      );
      throw e;
    }
  }
  console.log(`Pin resolution OK for ${circuit.elements.length} elements`);

  // Drive through compile — same path the engine uses.
  const facade = new DefaultSimulatorFacade(registry);
  try {
    const coord = facade.compile(circuit);
    console.log(`Compile OK — coordinator created`);
    void coord;
  } catch (e) {
    console.log("COMPILE ERROR:", e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack) {
      console.log(e.stack.split("\n").slice(0, 15).join("\n"));
    }
    process.exit(1);
  }

  // Try a netlist read — exercises another rendering-adjacent code path.
  try {
    const netlist = facade.netlist(circuit);
    console.log(
      `Netlist OK — components: ${netlist.components.length}, nets: ${netlist.nets.length}, diagnostics: ${netlist.diagnostics.length}`,
    );
    for (const d of netlist.diagnostics.slice(0, 5)) {
      console.log(`  diag: ${d.severity ?? "?"} ${d.code ?? "?"} ${d.message ?? ""}`);
    }
  } catch (e) {
    console.log("NETLIST ERROR:", e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack) {
      console.log(e.stack.split("\n").slice(0, 15).join("\n"));
    }
    process.exit(1);
  }
} catch (e) {
  console.log("ERROR:", e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) {
    console.log(e.stack.split("\n").slice(0, 12).join("\n"));
  }
  process.exit(1);
}
