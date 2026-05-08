/**
 * PROBE - Tracer-only investigation. Delete after diagnosis.
 *
 * Captures compile diagnostics for selectorBits=2 (passing) and selectorBits=3
 * (failing) to identify the exact predicate that drops the digital partition.
 */

import { describe, it } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

const registry = createDefaultRegistry();

function buildEncoder(selectorBits: number) {
  const inputCount = 1 << selectorBits;
  const facade = new DefaultSimulatorFacade(registry);

  const components: { id: string; type: string; props?: Record<string, number | string | boolean | number[]> }[] = [];
  const connections: [string, string][] = [];

  for (let i = 0; i < inputCount; i++) {
    components.push({ id: `in${i}`, type: "In", props: { label: `IN${i}`, bitWidth: 1 } });
    connections.push([`in${i}:out`, `pe:in${i}`]);
  }
  components.push({ id: "pe", type: "PriorityEncoder", props: { selectorBits } });
  components.push({ id: "num", type: "Out", props: { label: "NUM", bitWidth: selectorBits } });
  components.push({ id: "any", type: "Out", props: { label: "ANY", bitWidth: 1 } });
  connections.push(["pe:num", "num:in"]);
  connections.push(["pe:any", "any:in"]);

  const circuit = facade.build({
    components: components.map((c) =>
      c.props === undefined ? { id: c.id, type: c.type } : { id: c.id, type: c.type, props: c.props },
    ),
    connections: connections.map((c) => [c[0], c[1]] as [string, string]),
  });
  const coordinator = facade.compile(circuit);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compiled = (coordinator as any).compiled;
  return { circuit, coordinator, compiled };
}

describe("PROBE: priority-encoder partition drop", () => {
  it("dump diagnostics & topology for selectorBits=2 vs 3", () => {
    for (const sb of [2, 3]) {
      // eslint-disable-next-line no-console
      console.log("\n===== selectorBits =", sb, "=====");
      try {
        const { circuit, compiled } = buildEncoder(sb);
        // eslint-disable-next-line no-console
        console.log("digital partition:", compiled.digital ? "PRESENT" : "NULL (DROPPED)");
        // eslint-disable-next-line no-console
        console.log("labelSignalMap labels:", [...compiled.labelSignalMap.keys()]);
        // eslint-disable-next-line no-console
        console.log("diagnostics count:", compiled.diagnostics.length);
        for (const d of compiled.diagnostics) {
          // eslint-disable-next-line no-console
          console.log("  diag:", d.severity, d.code, ":", d.message);
        }
        // Element positions after autoLayout
        // eslint-disable-next-line no-console
        console.log("element positions:");
        for (const el of circuit.elements) {
          // eslint-disable-next-line no-console
          console.log(`  ${el.instanceId} type=${el.typeId} pos=(${el.position.x},${el.position.y})`);
          for (const pin of el.getPins()) {
            // worldPos approximation
            // eslint-disable-next-line no-console
            console.log(`    pin "${pin.label}" rel=(${pin.position.x},${pin.position.y}) bw=${pin.bitWidth} dir=${pin.direction}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log("wires:");
        for (const w of circuit.wires) {
          // eslint-disable-next-line no-console
          console.log(`  (${w.start.x},${w.start.y}) -> (${w.end.x},${w.end.y})`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log("compile threw:", (e as Error).message);
      }
    }
  });
});
