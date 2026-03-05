/**
 * Attribute mapping framework — converts .dig XML attribute entries into
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
import type { Rotation } from "../core/pin.js";
import { PropertyBag } from "../core/properties.js";
import type { DigEntry, DigValue } from "./dig-schema.js";

// ---------------------------------------------------------------------------
// DigAttributeMapping — extends AttributeMapping for typed DigValue conversion
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
 * Missing attributes (entries not present in the XML) are silently omitted —
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
      bag.set(mapping.propertyKey, mapping.convertDigValue(entry.value));
    } else {
      unmapped.set(entry.key, entry.value);
    }
  }

  if (unmapped.size > 0) {
    // Store unmapped entries under a reserved key for debugging / round-trip.
    // The value is cast through unknown because Map<string, DigValue> is not
    // in the PropertyValue union — it lives outside normal component property space.
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
 * Converter for <string> attribute values.
 *
 * @param xmlName   Key as it appears in the .dig XML (e.g. "Label").
 * @param propKey   Key used in the PropertyBag (e.g. "label").
 */
export function stringConverter(xmlName: string, propKey: string): DigAttributeMapping {
  return {
    xmlName,
    propertyKey: propKey,
    convert(xmlValue: string): PropertyValue {
      return xmlValue;
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "string") {
        throw new Error(`stringConverter: expected 'string' DigValue for "${xmlName}", got '${v.type}'`);
      }
      return v.value;
    },
  };
}

/**
 * Converter for <int> attribute values.
 *
 * @param xmlName   Key as it appears in the .dig XML (e.g. "Bits").
 * @param propKey   Key used in the PropertyBag (e.g. "bitWidth").
 */
export function intConverter(xmlName: string, propKey: string): DigAttributeMapping {
  return {
    xmlName,
    propertyKey: propKey,
    convert(xmlValue: string): PropertyValue {
      return parseInt(xmlValue, 10);
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "int") {
        throw new Error(`intConverter: expected 'int' DigValue for "${xmlName}", got '${v.type}'`);
      }
      return v.value;
    },
  };
}

/**
 * Converter for <long> attribute values (bigint).
 *
 * @param xmlName   Key as it appears in the .dig XML (e.g. "Value").
 * @param propKey   Key used in the PropertyBag (e.g. "value").
 */
export function bigintConverter(xmlName: string, propKey: string): DigAttributeMapping {
  return {
    xmlName,
    propertyKey: propKey,
    convert(xmlValue: string): PropertyValue {
      return BigInt(xmlValue);
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "long") {
        throw new Error(`bigintConverter: expected 'long' DigValue for "${xmlName}", got '${v.type}'`);
      }
      return v.value;
    },
  };
}

/**
 * Converter for <boolean> attribute values.
 *
 * @param xmlName   Key as it appears in the .dig XML (e.g. "wideShape").
 * @param propKey   Key used in the PropertyBag (e.g. "wideShape").
 */
export function boolConverter(xmlName: string, propKey: string): DigAttributeMapping {
  return {
    xmlName,
    propertyKey: propKey,
    convert(xmlValue: string): PropertyValue {
      return xmlValue === "true";
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "boolean") {
        throw new Error(`boolConverter: expected 'boolean' DigValue for "${xmlName}", got '${v.type}'`);
      }
      return v.value;
    },
  };
}

/**
 * Converter for <rotation> attribute values.
 *
 * The rotation is stored as a number 0–3 in the PropertyBag under the key
 * "rotation". This matches the Rotation type (0 | 1 | 2 | 3) from pin.ts.
 *
 * XML key is always "rotation" in .dig files.
 */
export function rotationConverter(): DigAttributeMapping {
  return {
    xmlName: "rotation",
    propertyKey: "rotation",
    convert(xmlValue: string): PropertyValue {
      const n = parseInt(xmlValue, 10) as Rotation;
      return n;
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "rotation") {
        throw new Error(`rotationConverter: expected 'rotation' DigValue, got '${v.type}'`);
      }
      return v.value as Rotation;
    },
  };
}

/**
 * Converter for <inverterConfig> attribute values.
 *
 * The inverter config is a list of input pin names that should have inversion
 * bubbles. Stored in the PropertyBag as a string[] (number[] is the other
 * array variant in PropertyValue, so we use string[] representation).
 *
 * XML key is always "inverterConfig" in .dig files.
 */
export function inverterConfigConverter(): DigAttributeMapping {
  return {
    xmlName: "inverterConfig",
    propertyKey: "inverterConfig",
    convert(_xmlValue: string): PropertyValue {
      throw new Error("inverterConfigConverter: string form not supported; use convertDigValue");
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "inverterConfig") {
        throw new Error(`inverterConfigConverter: expected 'inverterConfig' DigValue, got '${v.type}'`);
      }
      // PropertyValue includes number[] but not string[]. We store the pin
      // names as individual character codes would lose fidelity. Instead, we
      // encode each name in the array using a parallel string[] stored as a
      // custom property. Since PropertyValue = number | string | boolean | bigint | number[],
      // we store the labels as a JSON string.
      return JSON.stringify(v.value);
    },
  };
}

/**
 * Converter for <awt-color> attribute values.
 *
 * Stores the color as a JSON string in the PropertyBag under the key "color".
 * The component factory decodes it with JSON.parse.
 *
 * XML key is always "Color" in .dig files.
 */
export function colorConverter(): DigAttributeMapping {
  return {
    xmlName: "Color",
    propertyKey: "color",
    convert(_xmlValue: string): PropertyValue {
      return _xmlValue;
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "color") {
        throw new Error(`colorConverter: expected 'color' DigValue, got '${v.type}'`);
      }
      return JSON.stringify(v.value);
    },
  };
}

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

/**
 * Converter for <data> attribute values (ROM/RAM data fields).
 *
 * The raw comma-separated hex string (with run-length encoding) is stored
 * verbatim in the PropertyBag under the key "data". The engine's DataField
 * loader decodes it.
 *
 * XML key is always "Data" in .dig files.
 */
export function dataFieldConverter(): DigAttributeMapping {
  return {
    xmlName: "Data",
    propertyKey: "data",
    convert(xmlValue: string): PropertyValue {
      return xmlValue;
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "data") {
        throw new Error(`dataFieldConverter: expected 'data' DigValue, got '${v.type}'`);
      }
      return v.value;
    },
  };
}

/**
 * Converter for <value> attribute values (InDefault — input pin default value).
 *
 * Stores the inValue as a JSON string encoding { value: string (bigint repr), highZ: boolean }.
 * The bigint is stored as a decimal string to survive JSON serialization.
 *
 * XML key is always "InDefault" in .dig files.
 */
export function inValueConverter(): DigAttributeMapping {
  return {
    xmlName: "InDefault",
    propertyKey: "inDefault",
    convert(_xmlValue: string): PropertyValue {
      return _xmlValue;
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "inValue") {
        throw new Error(`inValueConverter: expected 'inValue' DigValue, got '${v.type}'`);
      }
      return JSON.stringify({ value: v.value.value.toString(), highZ: v.value.highZ });
    },
  };
}

/**
 * Converter for enum attribute values (intFormat, direction, barrelShifterMode, etc.).
 *
 * Stores the enum string value in the PropertyBag under the specified propKey.
 *
 * @param xmlName   Key as it appears in the .dig XML (e.g. "intFormat").
 * @param propKey   Key used in the PropertyBag (e.g. "intFormat").
 */
export function enumConverter(xmlName: string, propKey: string): DigAttributeMapping {
  return {
    xmlName,
    propertyKey: propKey,
    convert(xmlValue: string): PropertyValue {
      return xmlValue;
    },
    convertDigValue(v: DigValue): PropertyValue {
      if (v.type !== "enum") {
        throw new Error(`enumConverter: expected 'enum' DigValue for "${xmlName}", got '${v.type}'`);
      }
      return v.value;
    },
  };
}
