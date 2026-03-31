import { PropertyType } from "./properties.js";
import type { ParamDef } from "./registry.js";

interface ParamSpec {
  default: number;
  unit?: string;
  description?: string;
  min?: number;
  max?: number;
}

/**
 * Compact declaration that generates both the parameter schema (ParamDef[])
 * and the default values record from a single source of truth.
 *
 * Keys become both the ParamDef.key and ParamDef.label.
 * The `primary` group gets rank "primary"; `secondary` gets rank "secondary".
 */
export function defineModelParams(spec: {
  primary: Record<string, ParamSpec>;
  secondary?: Record<string, ParamSpec>;
}): { paramDefs: ParamDef[]; defaults: Record<string, number> } {
  const paramDefs: ParamDef[] = [];
  const defaults: Record<string, number> = {};

  for (const [key, s] of Object.entries(spec.primary)) {
    const pDef: ParamDef = { key, type: PropertyType.FLOAT, label: key, rank: "primary" };
    if (s.unit !== undefined) pDef.unit = s.unit;
    if (s.description !== undefined) pDef.description = s.description;
    if (s.min !== undefined) pDef.min = s.min;
    if (s.max !== undefined) pDef.max = s.max;
    paramDefs.push(pDef);
    defaults[key] = s.default;
  }

  if (spec.secondary) {
    for (const [key, s] of Object.entries(spec.secondary)) {
      const sDef: ParamDef = { key, type: PropertyType.FLOAT, label: key, rank: "secondary" };
      if (s.unit !== undefined) sDef.unit = s.unit;
      if (s.description !== undefined) sDef.description = s.description;
      if (s.min !== undefined) sDef.min = s.min;
      if (s.max !== undefined) sDef.max = s.max;
      paramDefs.push(sDef);
      defaults[key] = s.default;
    }
  }

  return { paramDefs, defaults };
}
