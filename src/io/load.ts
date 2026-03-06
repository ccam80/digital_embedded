/**
 * Native JSON load — deserialize a Circuit from a JSON string.
 *
 * Validates the document with a Zod schema, checks the version field,
 * restores bigint values from their "_bigint:<n>" string encoding,
 * creates elements via the ComponentRegistry factory, and reconstructs wires.
 */

import { z } from "zod";
import { Circuit, Wire } from "../core/circuit.js";
import type { CircuitMetadata } from "../core/circuit.js";
import type { ComponentRegistry } from "../core/registry.js";
import { PropertyBag } from "../core/properties.js";
import type { PropertyValue } from "../core/properties.js";
import { SAVE_FORMAT_VERSION, decodeBigint } from "./save.js";
import type { SavedCircuit } from "./save-schema.js";
import type { Rotation } from "../core/pin.js";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/**
 * A property value as it appears in the JSON file.
 * bigint is encoded as a "_bigint:<n>" string. All other forms pass through.
 */
const SavedPropertyValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string(),
  z.array(z.number()),
]);

const SavedMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
  measurementOrdering: z.array(z.string()),
  isGeneric: z.boolean(),
});

const SavedElementSchema = z.object({
  typeName: z.string(),
  instanceId: z.string(),
  position: PointSchema,
  rotation: z.number(),
  mirror: z.boolean(),
  properties: z.record(z.string(), SavedPropertyValueSchema),
});

const SavedWireSchema = z.object({
  p1: PointSchema,
  p2: PointSchema,
});

/** Zod schema for the complete saved circuit document. */
export const SavedCircuitSchema = z.object({
  version: z.number(),
  metadata: SavedMetadataSchema,
  elements: z.array(SavedElementSchema),
  wires: z.array(SavedWireSchema),
});

// ---------------------------------------------------------------------------
// Version migration
// ---------------------------------------------------------------------------

/**
 * Apply version migrations to bring an older saved document up to the current
 * format version. Currently a no-op since version 1 is the initial version.
 *
 * @throws Error if the version is higher than SAVE_FORMAT_VERSION (future file).
 */
export function migrateSavedCircuit(saved: SavedCircuit): SavedCircuit {
  if (saved.version > SAVE_FORMAT_VERSION) {
    throw new Error(
      `Cannot load circuit saved with format version ${saved.version}. ` +
        `This application supports up to version ${SAVE_FORMAT_VERSION}.`,
    );
  }
  // Version 1 → current: no structural changes needed.
  return saved;
}

// ---------------------------------------------------------------------------
// Property restoration
// ---------------------------------------------------------------------------

/**
 * Restore a single serialized property value to its runtime form.
 * Strings with the "_bigint:" prefix become native bigint.
 * All other values pass through unchanged.
 */
function restorePropertyValue(raw: unknown): PropertyValue {
  if (typeof raw === "string") {
    const bigintValue = decodeBigint(raw);
    if (bigintValue !== null) {
      return bigintValue;
    }
    return raw;
  }
  // number, boolean, number[] — already correct types
  return raw as PropertyValue;
}

/**
 * Restore a serialized properties record to a PropertyBag.
 */
function restoreProperties(
  record: Record<string, unknown>,
): PropertyBag {
  const entries: Array<[string, PropertyValue]> = [];
  for (const [key, raw] of Object.entries(record)) {
    entries.push([key, restorePropertyValue(raw)]);
  }
  return new PropertyBag(entries);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deserialize a Circuit from a JSON string produced by serializeCircuit().
 *
 * Pipeline:
 *   JSON.parse → Zod validation → version check/migration →
 *   property restoration → element creation → wire creation
 *
 * @throws ZodError if the JSON structure is invalid.
 * @throws Error if the version is too new or a typeName is not in the registry.
 */
export function deserializeCircuit(
  json: string,
  registry: ComponentRegistry,
): Circuit {
  const raw = JSON.parse(json) as unknown;
  const validated = SavedCircuitSchema.parse(raw) as SavedCircuit;
  const migrated = migrateSavedCircuit(validated);

  const metadata: Partial<CircuitMetadata> = {
    name: migrated.metadata.name,
    description: migrated.metadata.description,
    measurementOrdering: migrated.metadata.measurementOrdering,
    isGeneric: migrated.metadata.isGeneric,
  };

  const circuit = new Circuit(metadata);

  for (const saved of migrated.elements) {
    const def = registry.get(saved.typeName);
    if (def === undefined) {
      throw new Error(
        `deserializeCircuit: unknown component type "${saved.typeName}". ` +
          `Register it in the ComponentRegistry before loading.`,
      );
    }

    const props = restoreProperties(
      saved.properties as Record<string, unknown>,
    );
    const element = def.factory(props);

    // Apply placement fields from the saved document.
    element.position = { x: saved.position.x, y: saved.position.y };
    element.rotation = saved.rotation as Rotation;
    element.mirror = saved.mirror;

    circuit.addElement(element);
  }

  for (const sw of migrated.wires) {
    circuit.addWire(
      new Wire(
        { x: sw.p1.x, y: sw.p1.y },
        { x: sw.p2.x, y: sw.p2.y },
      ),
    );
  }

  return circuit;
}
