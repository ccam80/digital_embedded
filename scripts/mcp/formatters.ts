/**
 * Formatting helpers for MCP tool output.
 */

import type { Diagnostic, Netlist, PinDescriptor, NetDescriptor } from "../../src/headless/netlist-types.js";
import type { ComponentDefinition } from "../../src/core/registry.js";
import { PropertyBag } from "../../src/core/properties.js";

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "Diagnostics: none";

  const lines: string[] = [`Diagnostics (${diagnostics.length}):`];
  for (const d of diagnostics) {
    const severity = d.severity.toUpperCase();
    lines.push(`  ${severity} ${d.code}: ${d.message}`);
    if (d.fix) {
      lines.push(`    -> Fix: ${d.fix}`);
    }
    if (d.pins && d.pins.length > 0) {
      const pinList = d.pins
        .map((p) => `${p.componentLabel}:${p.pinLabel} [${p.declaredWidth}-bit, ${p.pinDirection}]`)
        .join(", ");
      lines.push(`    -> Pins: ${pinList}`);
    }
  }
  return lines.join("\n");
}

export function formatNetlist(netlist: Netlist): string {
  const lines: string[] = [];

  // Components section
  lines.push(`Components (${netlist.components.length}):`);
  for (const comp of netlist.components) {
    const label = comp.label ? ` "${comp.label}"` : "";
    const isAnalogOnly = comp.availableModels.length > 0
      && comp.availableModels.includes("analog")
      && !comp.availableModels.includes("digital");
    const pinSummary = comp.pins
      .map((p: PinDescriptor) =>
        isAnalogOnly
          ? `${p.label}[terminal]`
          : `${p.label}[${p.bitWidth}-bit, ${p.direction}]`,
      )
      .join(", ");

    // Show non-trivial properties (skip label — already shown — and position)
    const propEntries = Object.entries(comp.properties).filter(
      ([k]) => k !== "label" && k !== "position"
    );
    const propSuffix =
      propEntries.length > 0
        ? ` {${propEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}}`
        : "";

    const modelTag =
      comp.availableModels.length === 0 ? "" :
      comp.availableModels.includes("digital") && comp.availableModels.includes("analog") ? " [mixed]" :
      comp.availableModels.includes("analog") ? " [analog]" : " [digital]";
    lines.push(`  [${comp.index}] ${comp.typeId}${modelTag}${label}${propSuffix} — pins: ${pinSummary}`);
  }

  lines.push("");

  // Nets section
  const connectedNets = netlist.nets.filter((n: NetDescriptor) => n.pins.length > 0);
  lines.push(`Nets (${connectedNets.length}):`);
  for (const net of connectedNets) {
    const width = net.inferredWidth !== null ? `${net.inferredWidth}-bit` : "width-conflict";
    lines.push(`  Net #${net.netId} [${width}, ${net.pins.length} pins]:`);
    for (const pin of net.pins) {
      lines.push(
        `    ${pin.componentLabel}:${pin.pinLabel} [${pin.declaredWidth}-bit, ${pin.pinDirection}]`,
      );
    }
  }

  lines.push("");
  lines.push(formatDiagnostics(netlist.diagnostics));

  return lines.join("\n");
}

export function formatComponentDefinition(def: ComponentDefinition): string {
  const lines: string[] = [];
  lines.push(`Component: ${def.name}`);
  lines.push(`Category: ${def.category}`);
  const models = Object.keys(def.modelRegistry ?? {});
  if (models.length > 0) {
    lines.push(`Models: ${models.join(", ")}`);
  }

  if (def.helpText) {
    lines.push(`Help: ${def.helpText}`);
  }

  if (def.propertyDefs && def.propertyDefs.length > 0) {
    lines.push(`\nProperties (${def.propertyDefs.length}):`);
    for (const prop of def.propertyDefs) {
      const parts: string[] = [prop.type];
      if (prop.defaultValue !== undefined) parts.push(`default: ${String(prop.defaultValue)}`);
      if (prop.min !== undefined) parts.push(`min: ${prop.min}`);
      if (prop.max !== undefined) parts.push(`max: ${prop.max}`);
      lines.push(`  ${prop.key} (${parts.join(", ")})`);
      if (prop.description) {
        lines.push(`    ${prop.description}`);
      }
    }
  }

  if (def.attributeMap && def.attributeMap.length > 0) {
    lines.push(`\nAttribute map (XML → internal):`);
    for (const entry of def.attributeMap) {
      lines.push(`  ${entry.xmlName} → ${entry.propertyKey}`);
    }
  }

  if (def.pinLayout && def.pinLayout.length > 0) {
    // Identify which pins scale with the bitWidth property
    const scalingPins = new Set<string>();
    const bwPropDef = def.propertyDefs?.find((p) => p.key === "bitWidth");
    if (bwPropDef) {
      const testWidth = 16;
      const testBag = new PropertyBag();
      testBag.set("bitWidth", testWidth);
      try {
        const testElement = def.factory(testBag);
        for (const pin of testElement.getPins()) {
          if (pin.bitWidth === testWidth) {
            scalingPins.add(pin.label);
          }
        }
      } catch {
        /* factory may fail with minimal props — skip detection */
      }
    }

    const defIsAnalogOnly = !def.models?.digital
      && def.modelRegistry != null
      && Object.keys(def.modelRegistry).length > 0;
    lines.push(`\nPins (${def.pinLayout.length}):`);
    for (const pin of def.pinLayout) {
      if (defIsAnalogOnly) {
        lines.push(`  ${pin.label} [terminal, ${pin.direction}]`);
      } else {
        const scaleNote = scalingPins.has(pin.label) ? " (scales with bitWidth)" : "";
        lines.push(`  ${pin.label} [${pin.defaultBitWidth}-bit, ${pin.direction}]${scaleNote}`);
      }
    }
  }

  return lines.join("\n");
}
