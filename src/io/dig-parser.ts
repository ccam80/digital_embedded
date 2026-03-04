/**
 * .dig XML parser — converts Digital's XML format into a strongly-typed DigCircuit.
 *
 * Handles:
 * - XML string → DOM via browser DOMParser or @xmldom/xmldom (Node.js)
 * - Version extraction and migration (v0→1→2)
 * - XStream reference resolution (reference="../../../../..." paths)
 * - Attribute value parsing for all .dig value types
 * - Visual element and wire extraction
 * - Measurement ordering extraction
 */

import type {
  DigCircuit,
  DigEntry,
  DigValue,
  DigVisualElement,
  DigWire,
  DigPoint,
  RomListData,
} from "./dig-schema.js";
import { createDomParser } from "./dom-parser.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a .dig XML string into a strongly-typed DigCircuit parse tree.
 *
 * Applies version migration so the returned DigCircuit always reflects
 * format version 2 semantics, regardless of the file's version field.
 */
export function parseDigXml(xml: string): DigCircuit {
  const domParser = createDomParser();
  const doc = domParser.parse(xml);

  const root = doc.documentElement;
  if (!root || root.tagName !== "circuit") {
    throw new Error(`parseDigXml: expected root element <circuit>, got <${root?.tagName ?? "none"}>`);
  }

  const version = extractVersion(root);
  const attributes = extractEntries(getChildElement(root, "attributes"), root);
  const visualElements = extractVisualElements(root);
  const wires = extractWires(root);
  const measurementOrdering = extractMeasurementOrdering(root);

  const raw: DigCircuit = {
    version,
    attributes,
    visualElements,
    wires,
    ...(measurementOrdering !== undefined ? { measurementOrdering } : {}),
  };

  return migrateVersion(raw);
}

/**
 * Resolve an XStream reference path relative to a context element in the DOM.
 *
 * XStream uses paths like:
 *   "../../../../visualElement[3]/elementAttributes/entry/rotation"
 *
 * Each `..` steps to the parent. Segments with [N] index into child elements
 * with that tag name (1-based). Segments without [N] select the first matching child.
 *
 * @param refPath       The reference attribute value from the XML.
 * @param contextElement  The element containing the reference attribute.
 * @param _rootElement  Unused (kept for API symmetry with the spec).
 * @returns The resolved target Element.
 * @throws Error if the path cannot be resolved.
 */
export function resolveXStreamReference(
  refPath: string,
  contextElement: Element,
  _rootElement: Element,
): Element {
  const segments = refPath.split("/");
  let current: Element = contextElement;

  for (const segment of segments) {
    if (segment === "..") {
      const parent = current.parentElement ?? (current.parentNode as Element | null);
      if (!parent || parent.nodeType !== 1 /* ELEMENT_NODE */) {
        throw new Error(
          `resolveXStreamReference: cannot navigate to parent from <${current.tagName}> at segment ".."`,
        );
      }
      current = parent;
    } else if (segment === "") {
      // Leading slash or double slash — skip.
    } else {
      const bracketIdx = segment.indexOf("[");
      if (bracketIdx !== -1) {
        // Indexed: "tagName[N]" — 1-based index among same-tagged siblings.
        const tagName = segment.slice(0, bracketIdx);
        const index = parseInt(segment.slice(bracketIdx + 1, segment.indexOf("]")), 10);
        const matches = getChildElementsByTagName(current, tagName);
        if (index < 1 || index > matches.length) {
          throw new Error(
            `resolveXStreamReference: index [${index}] out of range for <${tagName}> (found ${matches.length}) in <${current.tagName}>`,
          );
        }
        current = matches[index - 1];
      } else {
        // Non-indexed: select first child with this tag name.
        const child = getChildElement(current, segment);
        if (!child) {
          throw new Error(
            `resolveXStreamReference: child <${segment}> not found in <${current.tagName}>`,
          );
        }
        current = child;
      }
    }
  }

  return current;
}

/**
 * Parse the value of a single attribute entry element.
 *
 * The value element is the second child of an `<entry>` — the first child is
 * always `<string>` (the key name). This function is called with the value
 * element directly.
 *
 * Unknown tag names are preserved as `{ type: 'enum'; xmlTag; value }`.
 *
 * @param valueElement  The XML element representing the value (e.g. `<int>`, `<boolean>`).
 * @param rootElement   The document root, used for XStream reference resolution.
 */
export function parseAttributeValue(valueElement: Element, rootElement: Element): DigValue {
  // Resolve XStream reference before parsing.
  const refAttr = valueElement.getAttribute("reference");
  if (refAttr !== null) {
    valueElement = resolveXStreamReference(refAttr, valueElement, rootElement);
  }

  const tag = valueElement.tagName;

  switch (tag) {
    case "string":
      return { type: "string", value: textContent(valueElement) };

    case "int":
      return { type: "int", value: parseInt(textContent(valueElement), 10) };

    case "long":
      return { type: "long", value: BigInt(textContent(valueElement)) };

    case "boolean":
      return { type: "boolean", value: textContent(valueElement) === "true" };

    case "rotation": {
      const raw = valueElement.getAttribute("rotation");
      if (raw === null) {
        throw new Error(`parseAttributeValue: <rotation> missing 'rotation' attribute`);
      }
      const n = parseInt(raw, 10);
      if (n !== 0 && n !== 1 && n !== 2 && n !== 3) {
        throw new Error(`parseAttributeValue: invalid rotation value ${n}`);
      }
      return { type: "rotation", value: n as 0 | 1 | 2 | 3 };
    }

    case "awt-color": {
      const r = parseInt(textContent(getRequiredChild(valueElement, "red")), 10);
      const g = parseInt(textContent(getRequiredChild(valueElement, "green")), 10);
      const b = parseInt(textContent(getRequiredChild(valueElement, "blue")), 10);
      const a = parseInt(textContent(getRequiredChild(valueElement, "alpha")), 10);
      return { type: "color", value: { r, g, b, a } };
    }

    case "testData": {
      const dsEl = getRequiredChild(valueElement, "dataString");
      return { type: "testData", value: textContent(dsEl) };
    }

    case "inverterConfig": {
      const strings = getChildElementsByTagName(valueElement, "string").map(textContent);
      return { type: "inverterConfig", value: strings };
    }

    case "data":
      return { type: "data", value: textContent(valueElement) };

    case "value": {
      const vAttr = valueElement.getAttribute("v");
      const zAttr = valueElement.getAttribute("z");
      if (vAttr === null) {
        throw new Error(`parseAttributeValue: <value> missing 'v' attribute`);
      }
      return {
        type: "inValue",
        value: { value: BigInt(vAttr), highZ: zAttr === "true" },
      };
    }

    case "romList":
      return { type: "romList", value: parseRomList(valueElement) };

    default:
      // Preserve unknown types as enum (future-proofing).
      return { type: "enum", xmlTag: tag, value: textContent(valueElement) };
  }
}

/**
 * Apply version migrations to upgrade a parsed DigCircuit to version 2.
 *
 * - Version 0 → 1: double all coordinate values (element positions and wire endpoints).
 * - Version 1 → 2: ROM manager format update (no-op in parse tree; romList structure
 *   is already normalized by parseRomList).
 *
 * Returns a new DigCircuit; does not mutate the input.
 */
export function migrateVersion(circuit: DigCircuit): DigCircuit {
  if (circuit.version === 2) return circuit;

  let migrated = circuit;

  if (migrated.version === 0) {
    migrated = {
      ...migrated,
      version: 1,
      visualElements: migrated.visualElements.map((ve) => ({
        ...ve,
        pos: { x: ve.pos.x * 2, y: ve.pos.y * 2 },
      })),
      wires: migrated.wires.map((w) => ({
        p1: { x: w.p1.x * 2, y: w.p1.y * 2 },
        p2: { x: w.p2.x * 2, y: w.p2.y * 2 },
      })),
    };
  }

  if (migrated.version === 1) {
    // Version 1 → 2: ROM format update is transparent at parse-tree level.
    migrated = { ...migrated, version: 2 };
  }

  return migrated;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractVersion(root: Element): number {
  const versionEl = getChildElement(root, "version");
  if (!versionEl) return 0;
  return parseInt(textContent(versionEl), 10);
}

function extractEntries(container: Element | null, rootElement: Element): DigEntry[] {
  if (!container) return [];
  const entries: DigEntry[] = [];
  for (const child of childElements(container)) {
    if (child.tagName !== "entry") continue;
    const children = childElements(child);
    if (children.length < 2) continue;
    const keyEl = children[0];
    const valueEl = children[1];
    if (keyEl.tagName !== "string") continue;
    const key = textContent(keyEl);
    const value = parseAttributeValue(valueEl, rootElement);
    entries.push({ key, value });
  }
  return entries;
}

function extractVisualElements(root: Element): DigVisualElement[] {
  const container = getChildElement(root, "visualElements");
  if (!container) return [];

  const result: DigVisualElement[] = [];
  for (const veEl of childElements(container)) {
    if (veEl.tagName !== "visualElement") continue;

    const nameEl = getChildElement(veEl, "elementName");
    const attrsEl = getChildElement(veEl, "elementAttributes");
    const posEl = getChildElement(veEl, "pos");

    if (!nameEl || !posEl) continue;

    const elementName = textContent(nameEl);
    const elementAttributes = extractEntries(attrsEl, root);
    const pos = extractPoint(posEl);

    result.push({ elementName, elementAttributes, pos });
  }
  return result;
}

function extractWires(root: Element): DigWire[] {
  const container = getChildElement(root, "wires");
  if (!container) return [];

  const result: DigWire[] = [];
  for (const wireEl of childElements(container)) {
    if (wireEl.tagName !== "wire") continue;
    const p1El = getChildElement(wireEl, "p1");
    const p2El = getChildElement(wireEl, "p2");
    if (!p1El || !p2El) continue;
    result.push({ p1: extractPoint(p1El), p2: extractPoint(p2El) });
  }
  return result;
}

function extractMeasurementOrdering(root: Element): string[] | undefined {
  const container = getChildElement(root, "measurementOrdering");
  if (!container) return undefined;
  return getChildElementsByTagName(container, "string").map(textContent);
}

function extractPoint(el: Element): DigPoint {
  const x = parseInt(el.getAttribute("x") ?? "0", 10);
  const y = parseInt(el.getAttribute("y") ?? "0", 10);
  return { x, y };
}

function parseRomList(romListEl: Element): RomListData {
  const romsEl = getChildElement(romListEl, "roms");
  if (!romsEl) return { files: [] };

  const files = getChildElementsByTagName(romsEl, "Entry").map((entryEl) => {
    const nameEl = getChildElement(entryEl, "string");
    const dataEl = getChildElement(entryEl, "data");
    return {
      name: nameEl ? textContent(nameEl) : "",
      data: dataEl ? textContent(dataEl) : "",
    };
  });

  return { files };
}

// ---------------------------------------------------------------------------
// DOM utility functions
// ---------------------------------------------------------------------------

function textContent(el: Element): string {
  return (el.textContent ?? "").trim();
}

function getChildElement(parent: Element, tagName: string): Element | null {
  const node = parent.firstChild;
  let current = node;
  while (current) {
    if (current.nodeType === 1 /* ELEMENT_NODE */ && (current as Element).tagName === tagName) {
      return current as Element;
    }
    current = current.nextSibling;
  }
  return null;
}

function getRequiredChild(parent: Element, tagName: string): Element {
  const el = getChildElement(parent, tagName);
  if (!el) {
    throw new Error(`parseAttributeValue: <${tagName}> not found in <${parent.tagName}>`);
  }
  return el;
}

function getChildElementsByTagName(parent: Element, tagName: string): Element[] {
  const result: Element[] = [];
  let current = parent.firstChild;
  while (current) {
    if (current.nodeType === 1 /* ELEMENT_NODE */ && (current as Element).tagName === tagName) {
      result.push(current as Element);
    }
    current = current.nextSibling;
  }
  return result;
}

function childElements(parent: Element): Element[] {
  const result: Element[] = [];
  let current = parent.firstChild;
  while (current) {
    if (current.nodeType === 1 /* ELEMENT_NODE */) {
      result.push(current as Element);
    }
    current = current.nextSibling;
  }
  return result;
}
