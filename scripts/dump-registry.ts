/**
 * dump-registry.ts — headless component-registry dump for external layout
 * tooling (lmschem's dts inventory generator).
 *
 * Emits one JSON object per standalone component definition: name, category,
 * per-pin LOCAL grid offsets (default properties, position {0,0}, rotation 0,
 * mirror false — so getPins() returns local space directly), the local body
 * bounding box, and the property definitions with defaults.  Pin positions
 * and bbox are in GRID UNITS, y increasing DOWNWARD (the editor convention;
 * see src/core/pin.ts pinWorldPosition).
 *
 * Configurations: an optional second argument names a JSON file mapping
 * component name -> [{name, props}].  For each entry the component is
 * instantiated AGAIN with the given properties overlaid on the defaults and
 * its pins/bbox dumped under that configuration name.  This is how external
 * tooling gets MEASURED pin tables for structural property settings
 * (inputCount, selectorBits, ...) instead of guessing layout rules.
 *
 * Run:  npx tsx scripts/dump-registry.ts [out.json] [configs.json]
 * Without arguments the JSON goes to stdout.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { createDefaultRegistry } from "../src/components/register-all.js";
import { PropertyBag } from "../src/core/properties.js";
import type { StandaloneComponentDefinition } from "../src/core/registry.js";

interface PinDump {
  label: string;
  x: number;
  y: number;
  direction: string;
  kind: string;
  defaultBitWidth: number;
  conditional: boolean;
  face: string | null;
}

interface ConfigDump {
  name: string;
  props: Record<string, unknown>;
  pins: PinDump[];
  bbox: { x: number; y: number; width: number; height: number } | null;
  error?: string;
}

interface DefDump {
  name: string;
  category: string;
  pins: PinDump[];
  bbox: { x: number; y: number; width: number; height: number } | null;
  properties: Array<{
    key: string;
    defaultValue: unknown;
    structural: boolean;
  }>;
  configurations?: ConfigDump[];
  error?: string;
}

function defaultBag(def: StandaloneComponentDefinition): PropertyBag {
  const bag = new PropertyBag();
  for (const pd of def.propertyDefs) {
    const d = (pd as { defaultValue?: unknown }).defaultValue;
    if (d !== undefined) {
      bag.set(pd.key, d as never);
    }
  }
  return bag;
}

function dumpInstance(
  def: StandaloneComponentDefinition,
  bag: PropertyBag,
): { pins: PinDump[]; bbox: DefDump["bbox"] } {
  const el = def.factory(bag);
  el.position = { x: 0, y: 0 };
  el.rotation = 0;
  el.mirror = false;
  const pins: PinDump[] = [];
  for (const pin of el.getPins()) {
    pins.push({
      label: pin.label,
      x: pin.position.x,
      y: pin.position.y,
      direction: String(pin.direction),
      kind: pin.kind ?? "signal",
      defaultBitWidth: pin.defaultBitWidth ?? 1,
      conditional: Boolean(pin.conditional),
      face: pin.face ?? null,
    });
  }
  const bb = el.getBoundingBox();
  // getBoundingBox returns world coords; position is (0,0) so it is local.
  return { pins, bbox: { x: bb.x, y: bb.y, width: bb.width, height: bb.height } };
}

function dumpDef(
  def: StandaloneComponentDefinition,
  configs: Array<{ name: string; props: Record<string, unknown> }> = [],
): DefDump {
  const out: DefDump = {
    name: def.name,
    category: String(def.category),
    pins: [],
    bbox: null,
    properties: def.propertyDefs.map((pd) => ({
      key: pd.key,
      defaultValue: (pd as { defaultValue?: unknown }).defaultValue ?? null,
      structural: Boolean((pd as { structural?: boolean }).structural),
    })),
  };
  try {
    const dumped = dumpInstance(def, defaultBag(def));
    out.pins = dumped.pins;
    out.bbox = dumped.bbox;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
  if (configs.length) {
    out.configurations = configs.map((cfg) => {
      const entry: ConfigDump = {
        name: cfg.name,
        props: cfg.props,
        pins: [],
        bbox: null,
      };
      try {
        const bag = defaultBag(def);
        for (const [key, value] of Object.entries(cfg.props)) {
          bag.set(key, value as never);
        }
        const dumped = dumpInstance(def, bag);
        entry.pins = dumped.pins;
        entry.bbox = dumped.bbox;
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
      return entry;
    });
  }
  return out;
}

const registry = createDefaultRegistry();
const defs = registry.getAllStandalone();

const configsPath = process.argv[3];
const allConfigs: Record<
  string,
  Array<{ name: string; props: Record<string, unknown> }>
> = configsPath ? JSON.parse(readFileSync(configsPath, "utf-8")) : {};
const knownNames = new Set(defs.map((d) => d.name));
// Underscore-prefixed keys are file comments, not component names.
const unknownConfigKeys = Object.keys(allConfigs).filter(
  (k) => !k.startsWith("_") && !knownNames.has(k),
);
if (unknownConfigKeys.length) {
  throw new Error(
    `configs file names unknown component types: ${unknownConfigKeys.join(", ")}`,
  );
}

const dump = {
  gridPixels: 20,
  yAxis: "down",
  components: defs
    .map((d) => dumpDef(d, allConfigs[d.name] ?? []))
    .sort((a, b) => a.name.localeCompare(b.name)),
};

const json = JSON.stringify(dump, null, 2);
const outPath = process.argv[2];
if (outPath) {
  writeFileSync(outPath, json);
  const failed = dump.components.filter((c) => c.error);
  console.log(
    `wrote ${dump.components.length} definitions to ${outPath}` +
      (failed.length
        ? ` (${failed.length} failed: ${failed.map((c) => c.name).join(", ")})`
        : ""),
  );
} else {
  console.log(json);
}
