/**
 * Audit the generated .dts for any malformed wire points or element positions
 * that could cause "cannot read properties of undefined, reading ('x')" in
 * the renderer.
 */

import { readFileSync } from "node:fs";

const doc = JSON.parse(
  readFileSync("circuits/sar_adc_4bit_from_dsl.dts", "utf-8"),
);

let bad = 0;
const wires = doc.circuit.wires as Array<{ points: Array<{ x: number; y: number }> }>;
wires.forEach((w, i) => {
  if (!Array.isArray(w.points)) {
    console.log("circuit wire", i, "no points array");
    bad++;
    return;
  }
  if (w.points.length < 2) {
    console.log("circuit wire", i, "fewer than 2 points");
    bad++;
    return;
  }
  for (let j = 0; j < w.points.length; j++) {
    const p = w.points[j];
    if (typeof p?.x !== "number" || typeof p?.y !== "number") {
      console.log(`circuit wire ${i} point ${j} malformed:`, p);
      bad++;
      return;
    }
  }
});

const elements = doc.circuit.elements as Array<{
  position?: { x: number; y: number };
  type: string;
  properties?: Record<string, unknown>;
}>;
elements.forEach((e, i) => {
  if (typeof e.position?.x !== "number" || typeof e.position?.y !== "number") {
    console.log(`circuit element ${i} (${e.type}) bad position:`, e.position);
    bad++;
  }
});

for (const [name, subRaw] of Object.entries(doc.subcircuitDefinitions ?? {})) {
  const sub = subRaw as { elements: typeof elements; wires: typeof wires };
  sub.elements.forEach((e, i) => {
    if (
      typeof e.position?.x !== "number" ||
      typeof e.position?.y !== "number"
    ) {
      console.log(
        `sub ${name} element ${i} (${e.type}) bad position:`,
        e.position,
      );
      bad++;
    }
  });
  sub.wires.forEach((w, i) => {
    if (!Array.isArray(w.points) || w.points.length < 2) {
      console.log(`sub ${name} wire ${i} malformed`);
      bad++;
    }
  });
}

console.log(
  `Audit complete — ${bad} issue(s) across ${wires.length} circuit wires, ${elements.length} circuit elements, ${Object.keys(doc.subcircuitDefinitions ?? {}).length} subcircuits.`,
);
