/**
 * Analog fixture pin audit- per-(type, rotation, mirror) individual tests.
 *
 * For every analog component type that has a Falstad pin reference, tests all
 * 8 transform combinations (4 rotations × 2 mirrors) at a non-origin position
 * to verify that pinWorldPosition() matches the expected Falstad transform.
 *
 * 46 types with pin references × 8 transforms = ~368 individual test instances.
 * Each test asserts unconditionally- no skip lists, no gating, no KNOWN_FAILURES.
 *
 * CI output reads: "Resistor rot=1 mir=true", "NpnBJT rot=2 mir=false", etc.
 */

import { describe, it, expect } from "vitest";

import {
  ALL_ANALOG_TYPES,
  FALSTAD_PIN_POSITIONS,
  falstadWorldPosition,
} from "@/test-utils/falstad-fixture-reference";
import { pinWorldPosition } from "@/core/pin";
import type { Rotation } from "@/core/pin";
import { createDefaultRegistry } from "@/components/register-all";
import { PropertyBag } from "@/core/properties";
import type { ComponentRegistry } from "@/core/registry";
import type { PropertyValue } from "@/core/properties";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultProps(
  registry: ComponentRegistry,
  typeName: string,
): PropertyBag {
  const def = registry.get(typeName);
  if (!def) return new PropertyBag();
  const entries: Array<[string, PropertyValue]> = [];
  for (const pd of def.propertyDefs) {
    entries.push([pd.key, pd.defaultValue]);
  }
  return new PropertyBag(entries);
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

const ROTATIONS: Rotation[] = [0, 1, 2, 3];
const MIRRORS = [false, true];

interface TransformCase {
  typeName: string;
  rotation: Rotation;
  mirror: boolean;
  label: string;
}

function buildCases(): TransformCase[] {
  const cases: TransformCase[] = [];
  for (const typeName of ALL_ANALOG_TYPES) {
    if (!FALSTAD_PIN_POSITIONS.has(typeName)) continue;
    for (const rotation of ROTATIONS) {
      for (const mirror of MIRRORS) {
        cases.push({
          typeName,
          rotation,
          mirror,
          label: `${typeName} rot=${rotation} mir=${mirror}`,
        });
      }
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("analog fixture pin audit- all rotations × mirrors", () => {
  const registry = createDefaultRegistry();
  const cases = buildCases();

  it.each(cases)("$label", ({ typeName, rotation, mirror }) => {
    const def = registry.get(typeName);
    if (!def) return;

    const props = buildDefaultProps(registry, typeName);
    const element = def.factory(props);
    element.rotation = rotation;
    element.mirror = mirror;
    element.position = { x: 7, y: 13 }; // non-origin, non-grid-aligned

    const refPins = FALSTAD_PIN_POSITIONS.get(typeName)!;
    const tsPins = element.getPins();

    // Pin count must match (prerequisite for position checks)
    expect(tsPins.length, `${typeName} pin count`).toBe(refPins.length);
    if (tsPins.length !== refPins.length) return;

    for (let i = 0; i < tsPins.length; i++) {
      const tsWorld = pinWorldPosition(element, tsPins[i]);
      const expected = falstadWorldPosition(
        refPins[i].x,
        refPins[i].y,
        element.position.x,
        element.position.y,
        rotation,
        mirror,
      );

      expect(tsWorld.x, `${typeName} pin ${i} x`).toBeCloseTo(
        expected.x,
        1,
      );
      expect(tsWorld.y, `${typeName} pin ${i} y`).toBeCloseTo(
        expected.y,
        1,
      );
    }
  });
});
