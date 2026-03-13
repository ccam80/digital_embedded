import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { loadDig } from "../dig-loader.js";
import { pinWorldPosition } from "../../core/pin.js";
import { createDefaultRegistry } from "../../components/register-all.js";

function ptKey(x: number, y: number): string {
  return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
}

describe("TC_testing orphan diagnosis", () => {
  it.each([
    "fixtures/Sim/TC_testing.dig",
    "fixtures/Sim/TC.dig",
    "fixtures/Sim/Processor/cpu_final.dig",
  ])("dump orphans in %s", (path) => {
    const xml = readFileSync(join(process.cwd(), path), "utf-8");
    const registry = createDefaultRegistry();
    const circuit = loadDig(xml, registry);

    // Collect all pin world positions
    const pinMap = new Map<string, { el: string; pin: string; negated: boolean }>();
    for (const el of circuit.elements) {
      for (const pin of el.getPins()) {
        const wp = pinWorldPosition(el, pin);
        const key = ptKey(wp.x, wp.y);
        pinMap.set(key, { el: el.typeId, pin: pin.label, negated: pin.isNegated });
      }
    }

    // Find orphans
    const pinPositions = new Set(pinMap.keys());
    const wireEndpoints = new Map<string, number>();
    for (const wire of circuit.wires) {
      const sk = ptKey(wire.start.x, wire.start.y);
      const ek = ptKey(wire.end.x, wire.end.y);
      wireEndpoints.set(sk, (wireEndpoints.get(sk) ?? 0) + 1);
      wireEndpoints.set(ek, (wireEndpoints.get(ek) ?? 0) + 1);
    }

    for (const wire of circuit.wires) {
      for (const ep of [wire.start, wire.end]) {
        const key = ptKey(ep.x, ep.y);
        const touchesPin = pinPositions.has(key);
        const isJunction = (wireEndpoints.get(key) ?? 0) >= 2;
        if (!touchesPin && !isJunction) {
          console.log("ORPHAN at", key);
          // Print nearby pins (within 2 grid units)
          for (const [pk, pv] of pinMap) {
            const [px, py] = pk.split(",").map(Number);
            const [ox, oy] = key.split(",").map(Number);
            if (Math.abs(px - ox) <= 2 && Math.abs(py - oy) <= 2) {
              console.log("  nearby pin:", pk, pv);
            }
          }
          // Print nearby elements
          for (const el of circuit.elements) {
            const dx = Math.abs(el.position.x - ep.x);
            const dy = Math.abs(el.position.y - ep.y);
            if (dx <= 5 && dy <= 5) {
              console.log("  nearby element:", el.typeId, "pos:", el.position, "rot:", el.rotation, "mirror:", el.mirror);
              for (const pin of el.getPins()) {
                const wp = pinWorldPosition(el, pin);
                console.log("    pin", pin.label, "world:", wp, "negated:", pin.isNegated);
              }
            }
          }
        }
      }
    }

    expect(true).toBe(true); // diagnostic only
  });
});
