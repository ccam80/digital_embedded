/**
 * Attribute mapping framework- converts .dig XML attribute entries into
 * PropertyBag entries for component instantiation.
 *
 * Per Decision 5: Components only see PropertyBag. The .dig attribute mapping
 * converts XML strings into PropertyBag entries. No other conversion path exists.
 *
 * Pipeline:
 *   DigEntry[] → AttributeMapping[].convertDigValue() → PropertyBag → factory(props) → CircuitElement
 */

import type { AttributeMapping } from "../core/registry.js";
import type { PropertyValue } from "../core/properties.js";
import { PropertyBag } from "../core/properties.js";
import type { DigEntry, DigValue } from "./dig-schema.js";

// ---------------------------------------------------------------------------
// DigAttributeMapping- extends AttributeMapping for typed DigValue conversion
// ---------------------------------------------------------------------------

/**
 * Extended AttributeMapping that adds a typed DigValue converter.
 *
 * The `convertDigValue` method is used by `applyAttributeMappings` to convert
 * a parsed DigEntry directly to a PropertyValue without round-tripping through
 * a string representation.
 *
 * Objects returned by the converter factories satisfy both `AttributeMapping`
 * (for registry storage) and `DigAttributeMapping` (for .dig parsing).
 */
export interface DigAttributeMapping extends AttributeMapping {
  /**
   * Convert a parsed DigValue to a PropertyValue.
   * Called by applyAttributeMappings for each matching DigEntry.
   */
  convertDigValue(v: DigValue): PropertyValue;
}

// ---------------------------------------------------------------------------
// applyAttributeMappings
// ---------------------------------------------------------------------------

/**
 * Convert a DigEntry[] to a PropertyBag using registered attribute mappings.
 *
 * For each entry, find the matching mapping by xmlName and call convertDigValue.
 * Entries with no matching mapping are preserved in a `_unmapped` key on the
 * PropertyBag as a Map<string, DigValue>.
 *
 * Missing attributes (entries not present in the XML) are silently omitted-
 * the component factory is responsible for applying defaults via getOrDefault().
 */
export function applyAttributeMappings(
  entries: DigEntry[],
  mappings: AttributeMapping[],
): PropertyBag {
  const bag = new PropertyBag();
  const unmapped = new Map<string, DigValue>();

  // Build a lookup map for O(1) access by xmlName
  const mappingByName = new Map<string, DigAttributeMapping>();
  for (const m of mappings) {
    if (isDigAttributeMapping(m)) {
      mappingByName.set(m.xmlName, m);
    }
  }

  for (const entry of entries) {
    const mapping = mappingByName.get(entry.key);
    if (mapping !== undefined) {
      const value = mapping.convertDigValue(entry.value);
      if (mapping.modelParam) {
        bag.setModelParam(mapping.propertyKey, value);
      } else {
        bag.set(mapping.propertyKey, value);
      }
    } else {
      unmapped.set(entry.key, entry.value);
    }
  }

  if (unmapped.size > 0) {
    // Store unmapped entries under a reserved key for debugging / round-trip.
    // The value is cast through unknown because Map<string, DigValue> is not
    // in the PropertyValue union- it lives outside normal component property space.
    (bag as unknown as { _unmapped: Map<string, DigValue> })._unmapped = unmapped;
  }

  return bag;
}

/**
 * Retrieve the unmapped entries preserved by applyAttributeMappings.
 * Returns an empty Map if the bag has no unmapped entries.
 */
export function getUnmapped(bag: PropertyBag): Map<string, DigValue> {
  const m = (bag as unknown as { _unmapped?: Map<string, DigValue> })._unmapped;
  return m ?? new Map();
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isDigAttributeMapping(m: AttributeMapping): m is DigAttributeMapping {
  return typeof (m as DigAttributeMapping).convertDigValue === "function";
}

// ---------------------------------------------------------------------------
// Converter factory functions
// ---------------------------------------------------------------------------

/**
 * Converter for <testData> attribute values.
 *
 * The testData contains a <dataString> with the raw test table text.
 * Stored as a plain string in the PropertyBag under the key "testData".
 *
 * XML key is always "Testdata" in .dig files.
 */
export function testDataConverter(): DigAttributeMapping {
  return {
    xmlName: "Testdata",
    propertyKey: "testData",
    convert(xmlValue: string): PropertyValue {
      return xmlValue;
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "testData") {
        throw new Error(`testDataConverter: expected 'testData' DigValue, got '${v.type}'`);
      }
      return v.value;
    },
  };
}

