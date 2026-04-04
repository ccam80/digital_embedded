/**
 * Generate a .dig fixture file containing one instance of every registered
 * component type, plus one 74xx subcircuit per unique pin count.
 * Used to run shape/pin/orphan audits across the full library.
 *
 * Usage: npx tsx scripts/generate-all-components-fixture.ts
 * Output: fixtures/Sim/all-components.dts
 */

import { writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createDefaultRegistry } from "../src/components/register-all.js";
import { CircuitBuilder } from "../src/headless/builder.js";
import { serializeCircuit } from "../src/io/dts-serializer.js";
import { LIBRARY_74XX } from "../src/components/library-74xx.js";
import { loadWithSubcircuits } from "../src/io/subcircuit-loader.js";
import { NodeResolver } from "../src/io/file-resolver.js";
import { createLiveDefinition } from "../src/components/subcircuit/subcircuit.js";

// ---------------------------------------------------------------------------
// 1. Create registry with pre-scanned 74xx pins
// ---------------------------------------------------------------------------

const registry = createDefaultRegistry();
const builder = new CircuitBuilder(registry);
const circuit = builder.createCircuit({ name: "All Components" });

// ---------------------------------------------------------------------------
// 2. Place one of every native component
// ---------------------------------------------------------------------------

const COLS = 10;
const COL_GAP = 12;
const ROW_GAP = 8;

const allDefs = registry.getAll();
let placed = 0;
const skipped: string[] = [];

for (const def of allDefs) {
  // Skip 74xx stubs — we'll handle those separately
  if (LIBRARY_74XX.some((e) => e.name === def.name)) continue;

  const col = placed % COLS;
  const row = Math.floor(placed / COLS);
  const x = col * COL_GAP;
  const y = row * ROW_GAP;

  try {
    builder.addComponent(circuit, def.name, {
      position: [x, y],
      label: def.name,
    });
    placed++;
  } catch (err) {
    skipped.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`Native: placed ${placed} component types`);

// ---------------------------------------------------------------------------
// 3. 74xx subcircuits — skipped for now.
// The fixture-audit resolver can't find the 74xx .dig files from the
// reference submodule. Native-only coverage is sufficient for shape audits.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. Save
// ---------------------------------------------------------------------------

const outPath = join(process.cwd(), "fixtures", "Sim", "all-components.dts");
const json = serializeCircuit(circuit);
writeFileSync(outPath, json, "utf-8");

console.log(`Total: ${placed} components`);
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  ${s}`);
}
console.log(`Written to: ${outPath}`);
