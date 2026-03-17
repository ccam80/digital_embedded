/**
 * TypeScript interfaces and validation for the .digb (digiTS)
 * native JSON format.
 *
 * .digb is the native save format for this project. .dig XML is the import
 * format for Digital compatibility only.
 */

// ---------------------------------------------------------------------------
// Schema interfaces
// ---------------------------------------------------------------------------

/** A 2D grid coordinate. */
export interface DigbPoint {
  x: number;
  y: number;
}

/**
 * A single placed component in a .digb circuit.
 *
 * The `type` field is the registry lookup key (e.g. "And", "In", "Out").
 * The `id` field is unique within the circuit.
 */
export interface DigbElement {
  /** Component type name (registry lookup key). */
  type: string;
  /** Unique element ID within the circuit. */
  id: string;
  /** Grid position of the element's origin. */
  position: DigbPoint;
  /** Rotation in degrees: 0, 90, 180, or 270. */
  rotation: number;
  /** Component-specific property values. */
  properties: Record<string, unknown>;
}

/**
 * A wire in a .digb circuit, represented as an ordered sequence of grid
 * points forming a polyline.
 */
export interface DigbWire {
  points: DigbPoint[];
}

/**
 * A single circuit (main or subcircuit) in the .digb format.
 */
export interface DigbCircuit {
  /** Display name for this circuit. */
  name: string;
  /** Optional description shown in the component palette. */
  description?: string;
  /** All placed elements. */
  elements: DigbElement[];
  /** All wire polylines. */
  wires: DigbWire[];
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
 * The root .digb document structure.
 *
 * A self-contained file: the main circuit and all referenced subcircuit
 * definitions are bundled together so no external files are needed.
 */
export interface DigbDocument {
  /** Format identifier — always the literal string "digb". */
  format: 'digb';
  /** Format version — currently always 1. */
  version: 1;
  /** The main circuit. */
  circuit: DigbCircuit;
  /**
   * Inline subcircuit definitions keyed by their circuit name.
   * Absent when the main circuit has no subcircuit references.
   */
  subcircuitDefinitions?: Record<string, DigbCircuit>;
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
 * Validate an unknown value as a DigbDocument.
 *
 * Checks structural requirements and field types. Returns the typed document
 * on success, throws a descriptive Error on any failure.
 */
export function validateDigbDocument(data: unknown): DigbDocument {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid .digb document: root value must be an object');
  }

  const doc = data as Record<string, unknown>;

  if (!('format' in doc)) {
    throw new Error('Invalid .digb document: missing required field "format"');
  }
  if (doc['format'] !== 'digb') {
    throw new Error(
      `Invalid .digb document: "format" must be "digb", got ${JSON.stringify(doc['format'])}`,
    );
  }

  if (!('version' in doc)) {
    throw new Error('Invalid .digb document: missing required field "version"');
  }
  if (doc['version'] !== 1) {
    throw new Error(
      `Invalid .digb document: unsupported version ${JSON.stringify(doc['version'])}, expected 1`,
    );
  }

  if (!('circuit' in doc)) {
    throw new Error('Invalid .digb document: missing required field "circuit"');
  }
  validateDigbCircuit(doc['circuit'], 'circuit');

  if ('subcircuitDefinitions' in doc && doc['subcircuitDefinitions'] !== undefined) {
    if (
      typeof doc['subcircuitDefinitions'] !== 'object' ||
      doc['subcircuitDefinitions'] === null ||
      Array.isArray(doc['subcircuitDefinitions'])
    ) {
      throw new Error(
        'Invalid .digb document: "subcircuitDefinitions" must be an object',
      );
    }
    for (const [key, value] of Object.entries(
      doc['subcircuitDefinitions'] as Record<string, unknown>,
    )) {
      validateDigbCircuit(value, `subcircuitDefinitions["${key}"]`);
    }
  }

  return doc as unknown as DigbDocument;
}

/** Validate a DigbCircuit value at the given JSON path for error messages. */
function validateDigbCircuit(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .digb document: "${path}" must be an object`);
  }

  const circuit = value as Record<string, unknown>;

  if (typeof circuit['name'] !== 'string') {
    throw new Error(
      `Invalid .digb document: "${path}.name" must be a string`,
    );
  }

  if (circuit['description'] !== undefined && typeof circuit['description'] !== 'string') {
    throw new Error(
      `Invalid .digb document: "${path}.description" must be a string when present`,
    );
  }

  if (!Array.isArray(circuit['elements'])) {
    throw new Error(
      `Invalid .digb document: "${path}.elements" must be an array`,
    );
  }
  for (let i = 0; i < (circuit['elements'] as unknown[]).length; i++) {
    validateDigbElement((circuit['elements'] as unknown[])[i], `${path}.elements[${i}]`);
  }

  if (!Array.isArray(circuit['wires'])) {
    throw new Error(
      `Invalid .digb document: "${path}.wires" must be an array`,
    );
  }
  for (let i = 0; i < (circuit['wires'] as unknown[]).length; i++) {
    validateDigbWire((circuit['wires'] as unknown[])[i], `${path}.wires[${i}]`);
  }

  if (circuit['testData'] !== undefined && typeof circuit['testData'] !== 'string') {
    throw new Error(
      `Invalid .digb document: "${path}.testData" must be a string when present`,
    );
  }

  if (circuit['isGeneric'] !== undefined && typeof circuit['isGeneric'] !== 'boolean') {
    throw new Error(
      `Invalid .digb document: "${path}.isGeneric" must be a boolean when present`,
    );
  }

  if (circuit['genericInitCode'] !== undefined && typeof circuit['genericInitCode'] !== 'string') {
    throw new Error(
      `Invalid .digb document: "${path}.genericInitCode" must be a string when present`,
    );
  }

  if (circuit['attributes'] !== undefined) {
    if (
      typeof circuit['attributes'] !== 'object' ||
      circuit['attributes'] === null ||
      Array.isArray(circuit['attributes'])
    ) {
      throw new Error(
        `Invalid .digb document: "${path}.attributes" must be an object when present`,
      );
    }
    for (const [k, v] of Object.entries(circuit['attributes'] as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(
          `Invalid .digb document: "${path}.attributes["${k}"]" must be a string`,
        );
      }
    }
  }
}

/** Validate a DigbElement value at the given JSON path for error messages. */
function validateDigbElement(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .digb document: "${path}" must be an object`);
  }

  const el = value as Record<string, unknown>;

  if (typeof el['type'] !== 'string') {
    throw new Error(`Invalid .digb document: "${path}.type" must be a string`);
  }
  if (typeof el['id'] !== 'string') {
    throw new Error(`Invalid .digb document: "${path}.id" must be a string`);
  }
  validateDigbPoint(el['position'], `${path}.position`);
  if (typeof el['rotation'] !== 'number') {
    throw new Error(`Invalid .digb document: "${path}.rotation" must be a number`);
  }
  if (el['properties'] === null || typeof el['properties'] !== 'object' || Array.isArray(el['properties'])) {
    throw new Error(`Invalid .digb document: "${path}.properties" must be an object`);
  }
}

/** Validate a DigbWire value at the given JSON path for error messages. */
function validateDigbWire(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .digb document: "${path}" must be an object`);
  }

  const wire = value as Record<string, unknown>;

  if (!Array.isArray(wire['points'])) {
    throw new Error(`Invalid .digb document: "${path}.points" must be an array`);
  }
  for (let i = 0; i < (wire['points'] as unknown[]).length; i++) {
    validateDigbPoint((wire['points'] as unknown[])[i], `${path}.points[${i}]`);
  }
}

/** Validate a DigbPoint value at the given JSON path for error messages. */
function validateDigbPoint(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid .digb document: "${path}" must be an object`);
  }
  const pt = value as Record<string, unknown>;
  if (typeof pt['x'] !== 'number') {
    throw new Error(`Invalid .digb document: "${path}.x" must be a number`);
  }
  if (typeof pt['y'] !== 'number') {
    throw new Error(`Invalid .digb document: "${path}.y" must be a number`);
  }
}
