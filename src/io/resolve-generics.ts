/**
 * HGS generic circuit resolution- port of Digital's ResolveGenerics.java.
 *
 * When a circuit has isGeneric: true, its GenericInitCode and GenericCode
 * elements contain HGS scripts that parameterize the circuit at load time.
 *
 * Resolution pipeline:
 *   1. Find the enabled GenericInitCode element. Execute its HGS code to
 *      produce an `args` context with parameter declarations.
 *   2. For GenericCode elements: execute HGS code with `args`, `addComponent`,
 *      and `addWire`. This programmatically generates circuit structure.
 *   3. For all other elements with a non-empty `generic` attribute: execute
 *      HGS code with `args` and `this` (a writable view of element attributes).
 *      The code may modify `this.*` attributes using XML attribute names
 *      (e.g. this.Inputs = args.inputs). After execution, a reverse attribute
 *      mapping converts XML names back to PropertyBag keys.
 *   4. Produce a resolved (non-generic) circuit with all parameters baked in.
 *
 * Results are cached by argument hash for performance.
 */

import { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { ComponentDefinition, ComponentRegistry } from "../core/registry.js";
import type { AttributeMapping } from "../core/registry.js";
import { resolveComponentDef } from "../core/resolve-component.js";
import type { FileResolver } from "../hgs/context.js";
import { HGSContext, createRootContext } from "../hgs/context.js";
import { registerBuiltins } from "../hgs/builtins.js";
import { HGSMap, HGSFunction, type HGSValue, toBigint, hgsToString } from "../hgs/value.js";
import { HGSEvalError } from "../hgs/parser-error.js";
import { parse } from "../hgs/parser.js";
import { evaluate } from "../hgs/evaluator.js";
import type { PropertyValue } from "../core/properties.js";
import { PropertyBag } from "../core/properties.js";
import type { Statement } from "../hgs/ast.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a circuit requires generic resolution.
 */
export function isGenericCircuit(circuit: Circuit): boolean {
  return circuit.metadata.isGeneric;
}

/**
 * Resolve a generic circuit with given arguments.
 *
 * When `args` is an empty Map, the enabled GenericInitCode element is executed
 * to produce the default arguments. When `args` is non-empty, those values are
 * used directly (used when the circuit is instantiated as a subcircuit with
 * explicit args from the parent).
 *
 * Returns a new resolved (non-generic) Circuit with all parameters baked in.
 */
export async function resolveGenericCircuit(
  circuit: Circuit,
  args: Map<string, HGSValue>,
  registry: ComponentRegistry,
  fileResolver?: FileResolver,
): Promise<Circuit> {
  const resolver = new GenericResolver(circuit, registry, fileResolver);
  return resolver.resolve(args);
}

// ---------------------------------------------------------------------------
// GenericResolutionCache
// ---------------------------------------------------------------------------

/**
 * Caches resolved circuits by argument hash.
 *
 * The cache key is a deterministic string serialization of the args Map.
 * Same args → same resolved circuit (returned by reference).
 */
export class GenericResolutionCache {
  private readonly _cache: Map<string, Circuit> = new Map();

  /**
   * Return a cached circuit for the given args key, or undefined if not cached.
   */
  get(argsKey: string): Circuit | undefined {
    return this._cache.get(argsKey);
  }

  /**
   * Store a resolved circuit under the given args key.
   */
  set(argsKey: string, circuit: Circuit): void {
    this._cache.set(argsKey, circuit);
  }

  /**
   * Compute a deterministic cache key from an args Map.
   *
   * Keys are sorted for stability. Values are serialized to their string
   * form using the same rules as HGS string output.
   */
  static keyFor(args: Map<string, HGSValue>): string {
    const entries = Array.from(args.entries()).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(entries.map(([k, v]) => [k, serializeHGSValue(v)]));
  }
}

// ---------------------------------------------------------------------------
// GenericResolver- internal implementation
// ---------------------------------------------------------------------------

/**
 * Encapsulates the resolution of one generic circuit.
 *
 * Caches parsed HGS statements by source string to avoid re-parsing the same
 * code string when multiple elements share it.
 */
class GenericResolver {
  private readonly circuit: Circuit;
  private readonly registry: ComponentRegistry;
  private readonly fileResolver: FileResolver | undefined;
  private readonly parsedCache: Map<string, Statement> = new Map();

  constructor(
    circuit: Circuit,
    registry: ComponentRegistry,
    fileResolver?: FileResolver,
  ) {
    this.circuit = circuit;
    this.registry = registry;
    this.fileResolver = fileResolver;
  }

  async resolve(externalArgs: Map<string, HGSValue>): Promise<Circuit> {
    const argsMap = await this.buildArgsMap(externalArgs);
    return this.createResolvedCircuit(argsMap);
  }

  /**
   * Build the args map from either the external args map or the enabled
   * GenericInitCode element.
   */
  private async buildArgsMap(externalArgs: Map<string, HGSValue>): Promise<HGSMap> {
    if (externalArgs.size > 0) {
      const map = new HGSMap();
      for (const [key, value] of externalArgs) {
        map.set(key, value);
      }
      return map;
    }

    // Find the single enabled GenericInitCode element
    const initElements = this.circuit.elements.filter(
      (el) => el.typeId === "GenericInitCode" && isElementEnabled(el),
    );

    if (initElements.length === 0) {
      throw new HGSEvalError("no enabled GenericInitCode element found in generic circuit");
    }
    if (initElements.length > 1) {
      throw new HGSEvalError("multiple enabled GenericInitCode elements found in generic circuit");
    }

    const initEl = initElements[0];
    const code = getGenericCode(initEl);

    const ctx = this.makeRootContext();
    if (code.trim().length > 0) {
      const stmt = this.parseCode(code);
      await evaluate(stmt, ctx);
    }

    return contextToMap(ctx);
  }

  /**
   * Create a resolved circuit by executing generic code on each element.
   *
   * Processing order (matching Java ResolveGenerics):
   *   1. GenericCode elements first (they add new components/wires).
   *   2. All other non-init elements after.
   */
  private async createResolvedCircuit(argsMap: HGSMap): Promise<Circuit> {
    const resolvedCircuit = new Circuit({
      ...this.circuit.metadata,
      isGeneric: false,
    });

    const newElements: CircuitElement[] = [];
    const newWires: Wire[] = [];

    const genericCodeEls = this.circuit.elements.filter(
      (el) => el.typeId === "GenericCode",
    );
    const otherEls = this.circuit.elements.filter(
      (el) => el.typeId !== "GenericCode" && el.typeId !== "GenericInitCode",
    );

    // Process GenericCode elements first
    for (const el of genericCodeEls) {
      await this.handleGenericCodeElement(el, argsMap, newElements, newWires);
    }

    // Process regular elements
    for (const el of otherEls) {
      const modified = await this.handleNonCodeElement(el, argsMap);
      resolvedCircuit.addElement(modified);
    }

    // Add original wires
    for (const wire of this.circuit.wires) {
      resolvedCircuit.addWire(new Wire(
        { x: wire.start.x, y: wire.start.y },
        { x: wire.end.x, y: wire.end.y },
      ));
    }

    // Add new wires generated by GenericCode
    for (const wire of newWires) {
      resolvedCircuit.addWire(wire);
    }

    // Add new elements generated by GenericCode
    for (const el of newElements) {
      resolvedCircuit.addElement(el);
    }

    return resolvedCircuit;
  }

  /**
   * Execute a GenericCode element's HGS script.
   *
   * The script has access to:
   *   - `args`: the resolved parameters (HGSMap)
   *   - `addComponent(typeName, x, y)`: adds a new element, returns writable attribute map
   *   - `addWire(x1, y1, x2, y2)`: adds a new wire
   */
  private async handleGenericCodeElement(
    el: CircuitElement,
    argsMap: HGSMap,
    newElements: CircuitElement[],
    newWires: Wire[],
  ): Promise<void> {
    const code = getGenericCode(el);
    if (code.trim().length === 0) return;

    const pendingElements: PendingElement[] = [];

    const ctx = this.makeRootContext();
    ctx.declareVar("args", argsMap);
    ctx.declareVar("addComponent", new HGSFunction(async (fnArgs) => {
      if (fnArgs.length < 3) {
        throw new HGSEvalError("addComponent requires 3 arguments: typeName, x, y");
      }
      const typeName = hgsToString(fnArgs[0]);
      const x = Number(toBigint(fnArgs[1]));
      const y = Number(toBigint(fnArgs[2]));
      return this.addComponent(typeName, x, y, pendingElements);
    }, "addComponent"));
    ctx.declareVar("addWire", new HGSFunction(async (fnArgs) => {
      if (fnArgs.length < 4) {
        throw new HGSEvalError("addWire requires 4 arguments: x1, y1, x2, y2");
      }
      const x1 = Number(toBigint(fnArgs[0]));
      const y1 = Number(toBigint(fnArgs[1]));
      const x2 = Number(toBigint(fnArgs[2]));
      const y2 = Number(toBigint(fnArgs[3]));
      newWires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
      return null;
    }, "addWire"));

    const stmt = this.parseCode(code);
    await evaluate(stmt, ctx);

    // Finalize all pending elements after the script completes
    for (const pending of pendingElements) {
      const finalEl = pending.finalize();
      newElements.push(finalEl);
    }
  }

  /**
   * Execute a non-code element's `generic` attribute code (if any).
   *
   * The `this` variable exposes the element's current property bag using
   * XML attribute names as keys (e.g. "Inputs", "Label", "Bits"). After
   * execution, the modified values are mapped back through the component's
   * AttributeMapping[] to produce the correct PropertyBag keys.
   *
   * Returns a newly constructed element with updated properties, or the
   * original element when no generic code is present.
   */
  private async handleNonCodeElement(
    el: CircuitElement,
    argsMap: HGSMap,
  ): Promise<CircuitElement> {
    const code = getGenericCode(el);
    if (code.trim().length === 0) return el;

    const def = resolveComponentDef(el.typeId, this.circuit, this.registry);
    if (def === undefined) return el;

    // Build a mutable map using XML attribute names as keys
    const thisMap = buildXmlAttributeMap(el.getProperties(), def);

    const ctx = this.makeRootContext();
    ctx.declareVar("args", argsMap);
    ctx.declareVar("this", thisMap);

    const stmt = this.parseCode(code);
    await evaluate(stmt, ctx);

    // Reconstruct the element from the modified XML-keyed attribute map
    const newProps = applyXmlMappingsToProps(thisMap, def);
    const newEl = def.factory(newProps);
    newEl.position = { x: el.position.x, y: el.position.y };
    newEl.rotation = el.rotation;
    return newEl;
  }

  /**
   * Add a new component and return a writable attribute map for the HGS code
   * to configure (e.g. `out.Label = "Y"`).
   */
  private addComponent(
    typeName: string,
    x: number,
    y: number,
    pendingElements: PendingElement[],
  ): ElementAttributeMap {
    const def = resolveComponentDef(typeName, this.circuit, this.registry);
    if (def === undefined) {
      throw new HGSEvalError(`addComponent: unknown component type "${typeName}"`);
    }

    // Start with an empty XML-keyed attribute map
    const attrMap = new ElementAttributeMap();
    const pending = new PendingElement(def, x, y, attrMap);
    pendingElements.push(pending);
    return attrMap;
  }

  private makeRootContext(): HGSContext {
    const ctx = createRootContext(this.fileResolver !== undefined ? { fileResolver: this.fileResolver } : {});
    registerBuiltins(ctx);
    return ctx;
  }

  private parseCode(code: string): Statement {
    const cached = this.parsedCache.get(code);
    if (cached !== undefined) return cached;
    const stmt = parse(code);
    this.parsedCache.set(code, stmt);
    return stmt;
  }
}

// ---------------------------------------------------------------------------
// PendingElement- deferred element waiting for attribute configuration
// ---------------------------------------------------------------------------

/**
 * Holds an element definition, position, and attribute map.
 *
 * The HGS script populates the attribute map via XML attribute names.
 * After the script completes, finalize() applies the attribute mappings
 * and reconstructs the element.
 */
class PendingElement {
  private readonly def: ComponentDefinition;
  private readonly x: number;
  private readonly y: number;
  private readonly attrMap: ElementAttributeMap;

  constructor(
    def: ComponentDefinition,
    x: number,
    y: number,
    attrMap: ElementAttributeMap,
  ) {
    this.def = def;
    this.x = x;
    this.y = y;
    this.attrMap = attrMap;
  }

  finalize(): CircuitElement {
    const props = applyXmlMappingsToProps(this.attrMap, this.def);
    const el = this.def.factory(props);
    el.position = { x: this.x, y: this.y };
    return el;
  }
}

// ---------------------------------------------------------------------------
// ElementAttributeMap- writable HGSMap using XML attribute names as keys
// ---------------------------------------------------------------------------

/**
 * An HGSMap that stores element attributes by their XML attribute names.
 *
 * HGS code accesses element attributes through `this` using XML names:
 *   this.Inputs = args.inputs;
 *   this.Label = "Y";
 *
 * After execution, `applyXmlMappingsToProps` converts XML names to
 * PropertyBag keys using the component's registered AttributeMapping[].
 */
class ElementAttributeMap extends HGSMap {
  private readonly _values: Map<string, HGSValue>;

  constructor(initial?: Map<string, HGSValue>) {
    super();
    this._values = initial ? new Map(initial) : new Map();
  }

  get(key: string): HGSValue {
    const v = this._values.get(key);
    return v !== undefined ? v : null;
  }

  set(key: string, v: HGSValue): void {
    this._values.set(key, v);
  }

  has(key: string): boolean {
    return this._values.has(key);
  }

  keys(): string[] {
    return Array.from(this._values.keys());
  }

  getXmlValues(): Map<string, HGSValue> {
    return this._values;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an ElementAttributeMap pre-populated with the element's current
 * properties, using XML attribute names as keys (reverse of AttributeMapping).
 *
 * Each AttributeMapping maps xmlName → propertyKey. We invert this to
 * populate the map with xmlName → current value.
 */
function buildXmlAttributeMap(
  props: PropertyBag,
  def: ComponentDefinition,
): ElementAttributeMap {
  const values = new Map<string, HGSValue>();

  for (const mapping of def.attributeMap) {
    if (props.has(mapping.propertyKey)) {
      const pv = props.get(mapping.propertyKey);
      values.set(mapping.xmlName, propertyValueToHGS(pv));
    }
  }

  return new ElementAttributeMap(values);
}

/**
 * Apply a component's AttributeMapping[] to an ElementAttributeMap to produce
 * a PropertyBag with correctly-named keys.
 *
 * XML attribute names (e.g. "Inputs") are mapped to property keys (e.g.
 * "inputCount") using the registered AttributeMapping[].
 *
 * For XML names not covered by any mapping, the raw HGSValue is converted to
 * a PropertyValue and stored under the XML name directly.
 */
function applyXmlMappingsToProps(
  attrMap: ElementAttributeMap,
  def: ComponentDefinition,
): PropertyBag {
  const bag = new PropertyBag();
  const xmlValues = attrMap.getXmlValues();

  // Build reverse lookup: xmlName → mapping
  const mappingByXml = new Map<string, AttributeMapping>();
  for (const m of def.attributeMap) {
    mappingByXml.set(m.xmlName, m);
  }

  for (const [xmlName, hgsVal] of xmlValues) {
    const mapping = mappingByXml.get(xmlName);
    if (mapping !== undefined) {
      // Convert via the registered converter using the string representation
      const strVal = hgsValToString(hgsVal);
      const propVal = mapping.convert(strVal);
      bag.set(mapping.propertyKey, propVal);
    } else {
      // No mapping- store under the XML name directly with direct conversion
      const pv = hgsValueToProperty(hgsVal);
      if (pv !== undefined) {
        bag.set(xmlName, pv);
      }
    }
  }

  return bag;
}

/**
 * Get the `generic` attribute code string from a CircuitElement's properties.
 * Returns empty string when absent.
 */
function getGenericCode(el: CircuitElement): string {
  const v = el.getAttribute("generic");
  if (v === undefined || v === null) return "";
  return String(v);
}

/**
 * Check whether a GenericInitCode element is enabled.
 * The `enabled` property defaults to true when absent.
 */
function isElementEnabled(el: CircuitElement): boolean {
  const v = el.getAttribute("enabled");
  if (v === undefined || v === null) return true;
  if (typeof v === "boolean") return v;
  return true;
}

/**
 * Build an HGSMap from an HGSContext's declared variables.
 */
function contextToMap(ctx: HGSContext): HGSMap {
  const map = new HGSMap();
  for (const key of ctx.getLocalKeys()) {
    // Keys from getLocalKeys() are guaranteed resolvable by the context
    // that produced them; no try/catch needed.
    map.set(key, ctx.getVar(key));
  }
  return map;
}

/**
 * Convert an HGSValue to a PropertyValue for storage in PropertyBag.
 */
function hgsValueToProperty(v: HGSValue): PropertyValue | undefined {
  if (v === null) return undefined;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v;
  return undefined;
}

/**
 * Convert a PropertyValue to the equivalent HGSValue.
 */
function propertyValueToHGS(v: PropertyValue): HGSValue {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v;
  return null;
}

/**
 * Convert an HGSValue to its string representation for use with
 * AttributeMapping.convert() which expects a string.
 */
function hgsValToString(v: HGSValue): string {
  if (v === null) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * Serialize an HGSValue to a stable string for use in cache keys.
 */
function serializeHGSValue(v: HGSValue): string {
  if (v === null) return "null";
  if (typeof v === "bigint") return `bigint:${v}`;
  if (v instanceof HGSMap) {
    const pairs = v.keys().sort().map((k) => `${k}:${serializeHGSValue(v.get(k))}`);
    return `{${pairs.join(",")}}`;
  }
  return String(v);
}
