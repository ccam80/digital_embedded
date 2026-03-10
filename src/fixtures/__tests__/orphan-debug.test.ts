/**
 * Temporary diagnostic test — dumps pin positions and orphan wire endpoints
 * for specific failing fixtures to identify which component pins are misplaced.
 */
import { describe, it, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";

import { createDefaultRegistry } from "@/components/register-all";
import type { ComponentRegistry } from "@/core/registry";
import { loadWithSubcircuits, clearSubcircuitCache } from "@/io/subcircuit-loader";
import type { FileResolver } from "@/io/file-resolver";
import { ResolverNotFoundError } from "@/io/file-resolver";
import type { Circuit } from "@/core/circuit";
import { pinWorldPosition } from "@/core/pin";

function ptKey(x: number, y: number): string {
  return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

function collectDigFiles(dir: string): string[] {
  const { readdirSync, statSync } = require("fs");
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectDigFiles(full));
    } else if (entry.endsWith(".dig")) {
      results.push(full);
    }
  }
  return results;
}

function buildDigIndex(roots: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const fullPath of collectDigFiles(root)) {
      const name = basename(fullPath);
      const key = name.endsWith(".dig") ? name.slice(0, -4) : name;
      if (!index.has(key)) index.set(key, fullPath);
      if (!index.has(name)) index.set(name, fullPath);
    }
  }
  return index;
}

class FixtureTreeResolver implements FileResolver {
  private readonly _index: Map<string, string>;
  private readonly _localDir: string;
  constructor(index: Map<string, string>, localDir: string) {
    this._index = index;
    this._localDir = localDir;
  }
  async resolve(name: string): Promise<string> {
    const suffix = name.endsWith(".dig") ? "" : ".dig";
    const localPath = join(this._localDir, name + suffix);
    if (existsSync(localPath)) return readFileSync(localPath, "utf-8");
    const key = name.endsWith(".dig") ? name.slice(0, -4) : name;
    const fullPath = this._index.get(key) ?? this._index.get(name);
    if (fullPath && existsSync(fullPath)) return readFileSync(fullPath, "utf-8");
    throw new ResolverNotFoundError(name);
  }
}

const PROJECT_ROOT = process.cwd();
const FIXTURE_ROOTS = [
  join(PROJECT_ROOT, "fixtures"),
  join(PROJECT_ROOT, "circuits"),
];

// Test a few small failing fixtures
const TARGETS = [
  "fixtures/Sim/TC.dig",
  "fixtures/mod3/Sim/ALU_checkpoint1.dig",
  "fixtures/Sim/GPIO_pin.dig",
  "fixtures/mod3/Sim/memory_recap/4x8bitreg_block.dig",
  "fixtures/Sim/PWM.dig",
];

describe("orphan diagnostics", () => {
  let registry: ComponentRegistry;
  let digIndex: Map<string, string>;

  beforeAll(() => {
    registry = createDefaultRegistry();
    digIndex = buildDigIndex(FIXTURE_ROOTS);
  });

  for (const target of TARGETS) {
    it(`diagnose ${basename(target)}`, async () => {
      clearSubcircuitCache();
      const fullPath = join(PROJECT_ROOT, target);
      if (!existsSync(fullPath)) {
        console.log(`SKIP: ${target} not found`);
        return;
      }
      const xml = readFileSync(fullPath, "utf-8");
      const localDir = dirname(fullPath);
      const resolver = new FixtureTreeResolver(digIndex, localDir);
      const circuit = await loadWithSubcircuits(xml, resolver, registry);

      // Build pin positions
      const pinPositions = new Set<string>();
      const pinDetails: { type: string; label: string; x: number; y: number }[] = [];
      for (const el of circuit.elements) {
        for (const pin of el.getPins()) {
          const wp = pinWorldPosition(el, pin);
          pinPositions.add(ptKey(wp.x, wp.y));
          pinDetails.push({
            type: el.typeId,
            label: pin.label,
            x: wp.x,
            y: wp.y,
          });
        }
      }

      // Wire endpoints
      const wireEndpoints = new Map<string, number>();
      for (const wire of circuit.wires) {
        const sk = ptKey(wire.start.x, wire.start.y);
        const ek = ptKey(wire.end.x, wire.end.y);
        wireEndpoints.set(sk, (wireEndpoints.get(sk) ?? 0) + 1);
        wireEndpoints.set(ek, (wireEndpoints.get(ek) ?? 0) + 1);
      }

      // Find orphans
      const orphans: { x: number; y: number }[] = [];
      for (const wire of circuit.wires) {
        for (const ep of [wire.start, wire.end]) {
          const key = ptKey(ep.x, ep.y);
          const touchesPin = pinPositions.has(key);
          const isJunction = (wireEndpoints.get(key) ?? 0) >= 2;
          if (!touchesPin && !isJunction) {
            orphans.push({ x: ep.x, y: ep.y });
          }
        }
      }

      if (orphans.length === 0) {
        console.log(`${basename(target)}: NO ORPHANS`);
        return;
      }

      console.log(`\n=== ${basename(target)} — ${orphans.length} orphan(s) ===`);
      const uniqueOrphans = [...new Set(orphans.map(o => `${o.x},${o.y}`))];
      for (const orphanKey of uniqueOrphans) {
        const [ox, oy] = orphanKey.split(",").map(Number);
        console.log(`\n  ORPHAN at (${ox}, ${oy}):`);

        // Find nearest pins (within 3 grid units)
        const nearby = pinDetails
          .filter(p => Math.abs(p.x - ox) <= 3 && Math.abs(p.y - oy) <= 3)
          .sort((a, b) => {
            const da = Math.abs(a.x - ox) + Math.abs(a.y - oy);
            const db = Math.abs(b.x - ox) + Math.abs(b.y - oy);
            return da - db;
          });
        if (nearby.length > 0) {
          console.log(`    Nearby pins (within 3 grid units):`);
          for (const p of nearby.slice(0, 8)) {
            const dist = Math.abs(p.x - ox) + Math.abs(p.y - oy);
            console.log(`      ${p.type}.${p.label} at (${p.x}, ${p.y}) [dist=${dist}]`);
          }
        } else {
          console.log(`    No pins within 3 grid units!`);
        }

        // Find all elements within 5 grid units
        const nearbyElements = new Set<string>();
        for (const el of circuit.elements) {
          const dx = Math.abs(el.position.x - ox);
          const dy = Math.abs(el.position.y - oy);
          if (dx <= 5 && dy <= 5) {
            nearbyElements.add(`${el.typeId} at (${el.position.x},${el.position.y}) rot=${el.rotation} mirror=${el.mirror}`);
          }
        }
        if (nearbyElements.size > 0) {
          console.log(`    Nearby elements (within 5 grid):`);
          for (const e of nearbyElements) {
            console.log(`      ${e}`);
          }
        }
      }
    });
  }
});
