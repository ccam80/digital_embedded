/**
 * TypeScript interfaces and validation for the .dts (digiTS)
 * native JSON format.
 *
 * .dts is the native save format for this project. .dig XML is the import
 * format for Digital compatibility only.
 */

// ---------------------------------------------------------------------------
// Schema interfaces
// ---------------------------------------------------------------------------

/** A 2D grid coordinate. */
export interface DtsPoint {
  x: number;
  y: number;
}

/**
 * A single placed component in a .dts circuit.
 *
 * The `type` field is the registry lookup key (e.g. "And", "In", "Out").
 * The `id` field is unique within the circuit.
 */
export interface DtsElement {
  /** Component type name (registry lookup key). */
  type: string;
  /** Unique element ID within the circuit. */
  id: string;
  /** Grid position of the element's origin. */
  position: DtsPoint;
  /** Rotation in degrees: 0, 90, 180, or 270. */
  rotation: number;
  /** Component-specific property values. */
  properties: Record<string, unknown>;
}

/**
 * A wire in a .dts circuit, represented as an ordered sequence of grid
 * points forming a polyline.
 */
export interface DtsWire {
  points: DtsPoint[];
}

/**
 * A single circuit (main or subcircuit) in the .dts format.
 */
export interface DtsCircuit {
  /** Display name for this circuit. */
  name: string;
  /** Optional description shown in the component palette. */
  description?: string;
  /** All placed elements. */
  elements: DtsElement[];
  /** All wire polylines. */
  wires: DtsWire[];
  /** Embedded test vectors in Digital test syntax. */
  testData?: string;
  /** Whether this circuit uses generic (parameterised) resolution. */
  isGeneric?: boolean;
  /** HGS initialisation script for generic circuits. */
  genericInitCode?: string;
  /** Circuit-level attributes (freeform key-value metadata). */
  attributes?: Record<string, string>;
}

/**
 * The root .dts document structure.
 *
 * A self-contained file: the main circuit and all referenced subcircuit
 * definitions are bundled together so no external files are needed.
 */
export interface DtsDocument {
  /** Format identifier — always the literal string "dts". */
  format: 'dts';
  /** Format version — currently always 1. */
  version: 1;
  /** The main circuit. */
  circuit: DtsCircuit;
  /**
   * Inline subcircuit definitions keyed by their circuit name.
   * Absent when the main circuit has no subcircuit references.
   */
  subcircuitDefinitions?: Record<string, DtsCircuit>;
  /**
   * Model subcircuit definitions keyed by model name (e.g. "CmosAnd2",
   * "user_opamp_741"). Expanded inline by the compiler; not instantiated
   * as subcircuit elements.
   */
  modelDefinitions?: Record<string, DtsCircuit>;
  /**
   * Named SPICE .MODEL parameter sets keyed by model name (e.g. "1N4148",
   * "2N2222"). Populated on load into the ModelLibrary.
   */
  namedParameterSets?: Record<string, {
    deviceType: string;
    params: Record<string, number>;
  }>;
  /**
   * Embedded FSM (finite state machine) definition.
   * Present when the document contains an FSM editor state.
   */
  fsm?: object;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as a DtsDocument.
 *
 * Checks structural requirements and field types. Returns the typed document
 * on success, throws a descriptive Error on any failure.
 *
 * Accepts both `format: 'dts'` (current) and `format: 'digb'`.
 */
export function validateDtsDocument(data: unknown): DtsDocument {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid .dts document: root value must be an object');
  }

  const doc = data as Record<string, unknown>;

  if (!('format' in doc)) {
    throw new Error('Invalid .dts document: missing required field "format"');
  }
  if (doc['format'] !== 'dts' && doc['format'] !== 'digb') {
    throw new Error(
      `Invalid .dts document: "format" must be "dts", got ${JSON.stringify(doc['format'])}`,
    );
  }

  if (!('version' in doc)) {
    throw new Error('Invalid .dts document: missing required field "version"');
  }
  if (doc['version'] !== 1) {
    throw new Error(
      `Invalid .dts document: unsupported version ${JSON.stringify(doc['version'])}, expected 1`,
    );
  }

  if (!('circuit' in doc)) {
    throw new Error('Invalid .dts document: missing required field "circuit"');
  }
  validateDtsCircuit(doc['circuit'], 'circuit');

  if ('subcircuitDefinitions' in doc && doc['subcircuitDefinitions'] !== undefined) {
    if (
      typeof doc['subcircuitDefinitions'] !== 'object' ||
      doc['subcircuitDefinitions'] === null ||
      Array.isArray(doc['subcircuitDefinitions'])
    ) {
      throw new Error(
        'Invalid .dts document: "subcircuitDefinitions" must be an object',
      );
    }
    for (const [key, value] of Object.entries(
      doc['subcircuitDefinitions'] as Record<string, unknown>,
    )) {
      validateDtsCircuit(value, `subcircuitDefinitions["${key}"]`);
    }
  }

  if ('modelDefinitions' in doc && doc['modelDefinitions'] !== undefined) {
    if (
      typeof doc['modelDefinitions'] !== 'object' ||
      doc['modelDefinitions'] === null ||
      Array.isArray(doc['modelDefinitions'])
    ) {
      throw new Error(
        'Invalid .dts document: "modelDefinitions" must be an object',
      );
    }
    for (const [key, value] of Object.entries(
      doc['modelDefinitions'] as Record<string, unknown>,
    )) {
      validateDtsCircuit(value, `modelDefinitions["${key}"]`);
    }
  }

  if ('namedParameterSets' in doc && doc['namedParameterSets'] !== undefined) {
    if (
      typeof doc['namedParameterSets'] !== 'object' ||
      doc['namedParameterSets'] === null ||
      Array.isArray(doc['namedParameterSets'])
    ) {
      throw new Error(
        'Invalid .dts document: "namedParameterSets" must be an object',
      );
    }
    for (const [key, entry] of Object.entries(
      doc['namedParameterSets'] as Record<string, unknown>,
    )) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry)
      ) {
        throw new Error(
          `Invalid .dts document: "namedParameterSets["${key}"]" must be an object`,
        );
      }
      const e = entry as Record<string, unknown>;
      if (typeof e['deviceType'] !== 'string') {
        throw new Error(
          `Invalid .dts document: "namedParameterSets["${key}"].deviceType" must be a string`,
        );
      }
      if (
        typeof e['params'] !== 'object' ||
        e['params'] === null ||
        Array.isArray(e['params'])
      ) {
        throw new Error(
          `Invalid .dts document: "namedParameterSets["${key}"].params" must be an object`,
        );
      }
      for (const [pk, pv] of Object.entries(e['params'] as Record<string, unknown>)) {
        if (typeof pv !== 'number') {
          throw new Error(
            `Invalid .dts document: "namedParameterSets["${key}"].params["${pk}"]" must be a number`,
          );
        }
      }
    }
  }

  const normalized = { ...doc, format: 'dts' };
  return normalized as unknown as DtsDocument;
}

/** Validate a DtsCircuit value at the given JSON path for error messages. */
function validateDtsCircuit(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .dts document: "${path}" must be an object`);
  }

  const circuit = value as Record<string, unknown>;

  if (typeof circuit['name'] !== 'string') {
    throw new Error(
      `Invalid .dts document: "${path}.name" must be a string`,
    );
  }

  if (circuit['description'] !== undefined && typeof circuit['description'] !== 'string') {
    throw new Error(
      `Invalid .dts document: "${path}.description" must be a string when present`,
    );
  }

  if (!Array.isArray(circuit['elements'])) {
    throw new Error(
      `Invalid .dts document: "${path}.elements" must be an array`,
    );
  }
  for (let i = 0; i < (circuit['elements'] as unknown[]).length; i++) {
    validateDtsElement((circuit['elements'] as unknown[])[i], `${path}.elements[${i}]`);
  }

  if (!Array.isArray(circuit['wires'])) {
    throw new Error(
      `Invalid .dts document: "${path}.wires" must be an array`,
    );
  }
  for (let i = 0; i < (circuit['wires'] as unknown[]).length; i++) {
    validateDtsWire((circuit['wires'] as unknown[])[i], `${path}.wires[${i}]`);
  }

  if (circuit['testData'] !== undefined && typeof circuit['testData'] !== 'string') {
    throw new Error(
      `Invalid .dts document: "${path}.testData" must be a string when present`,
    );
  }

  if (circuit['isGeneric'] !== undefined && typeof circuit['isGeneric'] !== 'boolean') {
    throw new Error(
      `Invalid .dts document: "${path}.isGeneric" must be a boolean when present`,
    );
  }

  if (circuit['genericInitCode'] !== undefined && typeof circuit['genericInitCode'] !== 'string') {
    throw new Error(
      `Invalid .dts document: "${path}.genericInitCode" must be a string when present`,
    );
  }

  if (circuit['attributes'] !== undefined) {
    if (
      typeof circuit['attributes'] !== 'object' ||
      circuit['attributes'] === null ||
      Array.isArray(circuit['attributes'])
    ) {
      throw new Error(
        `Invalid .dts document: "${path}.attributes" must be an object when present`,
      );
    }
    for (const [k, v] of Object.entries(circuit['attributes'] as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(
          `Invalid .dts document: "${path}.attributes["${k}"]" must be a string`,
        );
      }
    }
  }
}

/** Validate a DtsElement value at the given JSON path for error messages. */
function validateDtsElement(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .dts document: "${path}" must be an object`);
  }

  const el = value as Record<string, unknown>;

  if (typeof el['type'] !== 'string') {
    throw new Error(`Invalid .dts document: "${path}.type" must be a string`);
  }
  if (typeof el['id'] !== 'string') {
    throw new Error(`Invalid .dts document: "${path}.id" must be a string`);
  }
  validateDtsPoint(el['position'], `${path}.position`);
  if (typeof el['rotation'] !== 'number') {
    throw new Error(`Invalid .dts document: "${path}.rotation" must be a number`);
  }
  if (el['properties'] === null || typeof el['properties'] !== 'object' || Array.isArray(el['properties'])) {
    throw new Error(`Invalid .dts document: "${path}.properties" must be an object`);
  }
}

/** Validate a DtsWire value at the given JSON path for error messages. */
function validateDtsWire(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .dts document: "${path}" must be an object`);
  }

  const wire = value as Record<string, unknown>;

  if (!Array.isArray(wire['points'])) {
    throw new Error(`Invalid .dts document: "${path}.points" must be an array`);
  }
  for (let i = 0; i < (wire['points'] as unknown[]).length; i++) {
    validateDtsPoint((wire['points'] as unknown[])[i], `${path}.points[${i}]`);
  }
}

/** Validate a DtsPoint value at the given JSON path for error messages. */
function validateDtsPoint(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .dts document: "${path}" must be an object`);
  }
  const pt = value as Record<string, unknown>;
  if (typeof pt['x'] !== 'number') {
    throw new Error(`Invalid .dts document: "${path}.x" must be a number`);
  }
  if (typeof pt['y'] !== 'number') {
    throw new Error(`Invalid .dts document: "${path}.y" must be a number`);
  }
}
