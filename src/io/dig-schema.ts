/**
 * TypeScript types for the .dig XML parse tree.
 *
 * These represent the raw deserialized XML structure before attribute mapping
 * converts entries to PropertyBag entries. The discriminated union on DigValue
 * enables exhaustive switch statements over all attribute value types.
 */

// ---------------------------------------------------------------------------
// Coordinate pair
// ---------------------------------------------------------------------------

/** A 2D integer grid position (x, y). */
export interface DigPoint {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// ROM data structures
// ---------------------------------------------------------------------------

/**
 * A single ROM file entry as stored in the romList.
 * Represents a named ROM content block mapped to a specific address.
 */
export interface RomFileEntry {
  /** File name referenced by the ROM element (relative path). */
  name: string;
  /** ROM data as comma-separated hex with run-length encoding. */
  data: string;
}

/**
 * ROM list data: the deserialized form of a <romList> element.
 * Digital uses this to store multiple ROM content blocks in one attribute.
 */
export interface RomListData {
  /** Ordered list of ROM file entries. */
  files: RomFileEntry[];
}

// ---------------------------------------------------------------------------
// Attribute value discriminated union
// ---------------------------------------------------------------------------

/**
 * All possible attribute value types in a .dig XML file.
 *
 * Each variant has a `type` discriminant field enabling exhaustive switch:
 *
 *   switch (entry.value.type) {
 *     case 'string':        entry.value.value  // string
 *     case 'int':           entry.value.value  // number
 *     case 'long':          entry.value.value  // bigint
 *     case 'boolean':       entry.value.value  // boolean
 *     case 'rotation':      entry.value.value  // 0|1|2|3
 *     case 'color':         entry.value.value  // {r,g,b,a}
 *     case 'testData':      entry.value.value  // string (dataString content)
 *     case 'inverterConfig': entry.value.value // string[]
 *     case 'data':          entry.value.value  // string (comma-sep hex)
 *     case 'inValue':       entry.value.value  // {value: bigint; highZ: boolean}
 *     case 'romList':       entry.value.value  // RomListData
 *     case 'enum':          entry.value.value + entry.value.xmlTag
 *   }
 */
export type DigValue =
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'boolean'; value: boolean }
  | { type: 'rotation'; value: 0 | 1 | 2 | 3 }
  | { type: 'color'; value: { r: number; g: number; b: number; a: number } }
  | { type: 'testData'; value: string }
  | { type: 'inverterConfig'; value: string[] }
  | { type: 'data'; value: string }
  | { type: 'inValue'; value: { value: bigint; highZ: boolean } }
  | { type: 'romList'; value: RomListData }
  | { type: 'enum'; xmlTag: string; value: string };

// ---------------------------------------------------------------------------
// Parse tree nodes
// ---------------------------------------------------------------------------

/**
 * A single key-value attribute entry within an element's <elementAttributes>.
 * The key is the Digital attribute name (e.g. "Bits", "Label", "rotation").
 */
export interface DigEntry {
  key: string;
  value: DigValue;
}

/**
 * A placed visual element within the circuit.
 * Corresponds to a <visualElement> in the XML.
 */
export interface DigVisualElement {
  /** Component type name matching the registry (e.g. "And", "In", "Out"). */
  elementName: string;
  /** Parsed attribute entries for this element. */
  elementAttributes: DigEntry[];
  /** Grid position of the element's origin. */
  pos: DigPoint;
}

/**
 * A wire segment connecting two grid points.
 * Corresponds to a <wire> in the XML.
 */
export interface DigWire {
  p1: DigPoint;
  p2: DigPoint;
}

/**
 * The root parse tree produced by the .dig XML parser.
 * Contains all structural information from a .dig file after
 * version migration and XStream reference resolution.
 */
export interface DigCircuit {
  /** File format version (0, 1, or 2). Always 2 after migration. */
  version: number;
  /** Circuit-level attributes (romContent, Width, Height, Description, isGeneric). */
  attributes: DigEntry[];
  /** All placed visual elements. */
  visualElements: DigVisualElement[];
  /** All wire segments. */
  wires: DigWire[];
  /** Optional ordered list of signal names for measurement display. */
  measurementOrdering?: string[];
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard for string DigValue. */
export function isStringValue(v: DigValue): v is { type: 'string'; value: string } {
  return v.type === 'string';
}

/** Type guard for int DigValue. */
export function isIntValue(v: DigValue): v is { type: 'int'; value: number } {
  return v.type === 'int';
}

/** Type guard for long DigValue. */
export function isLongValue(v: DigValue): v is { type: 'long'; value: bigint } {
  return v.type === 'long';
}

/** Type guard for boolean DigValue. */
export function isBooleanValue(v: DigValue): v is { type: 'boolean'; value: boolean } {
  return v.type === 'boolean';
}

/** Type guard for rotation DigValue. */
export function isRotationValue(v: DigValue): v is { type: 'rotation'; value: 0 | 1 | 2 | 3 } {
  return v.type === 'rotation';
}

/** Type guard for color DigValue. */
export function isColorValue(v: DigValue): v is { type: 'color'; value: { r: number; g: number; b: number; a: number } } {
  return v.type === 'color';
}

/** Type guard for testData DigValue. */
export function isTestDataValue(v: DigValue): v is { type: 'testData'; value: string } {
  return v.type === 'testData';
}

/** Type guard for inverterConfig DigValue. */
export function isInverterConfigValue(v: DigValue): v is { type: 'inverterConfig'; value: string[] } {
  return v.type === 'inverterConfig';
}

/** Type guard for data DigValue. */
export function isDataValue(v: DigValue): v is { type: 'data'; value: string } {
  return v.type === 'data';
}

/** Type guard for inValue DigValue. */
export function isInValueValue(v: DigValue): v is { type: 'inValue'; value: { value: bigint; highZ: boolean } } {
  return v.type === 'inValue';
}

/** Type guard for romList DigValue. */
export function isRomListValue(v: DigValue): v is { type: 'romList'; value: RomListData } {
  return v.type === 'romList';
}

/** Type guard for enum DigValue. */
export function isEnumValue(v: DigValue): v is { type: 'enum'; xmlTag: string; value: string } {
  return v.type === 'enum';
}

/**
 * All known DigValue type discriminants.
 * Used to verify exhaustive coverage of the discriminated union.
 */
export const DIG_VALUE_TYPES = [
  'string',
  'int',
  'long',
  'boolean',
  'rotation',
  'color',
  'testData',
  'inverterConfig',
  'data',
  'inValue',
  'romList',
  'enum',
] as const satisfies ReadonlyArray<DigValue['type']>;
