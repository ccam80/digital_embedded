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
    paramDefs.push({
      key,
      type: PropertyType.FLOAT,
      label: key,
      unit: s.unit,
      description: s.description,
      rank: "primary",
      min: s.min,
      max: s.max,
    });
    defaults[key] = s.default;
  }

  if (spec.secondary) {
    for (const [key, s] of Object.entries(spec.secondary)) {
      paramDefs.push({
        key,
        type: PropertyType.FLOAT,
        label: key,
        unit: s.unit,
        description: s.description,
        rank: "secondary",
        min: s.min,
        max: s.max,
      });
      defaults[key] = s.default;
    }
  }

  return { paramDefs, defaults };
}
