/**
 * ModelLibrary — stores and resolves device models.
 *
 * Provides built-in Level 2 SPICE default parameter sets for every device
 * type so components work without explicit .MODEL cards. User-supplied models
 * override defaults by name.
 */

import type { DeviceType } from "./model-parser.js";
import {
  DIODE_DEFAULTS,
  BJT_NPN_DEFAULTS,
  BJT_PNP_DEFAULTS,
  MOSFET_NMOS_DEFAULTS,
  MOSFET_PMOS_DEFAULTS,
  JFET_N_DEFAULTS,
  JFET_P_DEFAULTS,
  TUNNEL_DIODE_DEFAULTS,
} from "./model-defaults.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";
import { makeDiagnostic } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// DeviceModel
// ---------------------------------------------------------------------------

/** A resolved device model with name, type, level, and parameters. */
export interface DeviceModel {
  /** Model name (e.g. "1N4148", "2N2222"). */
  name: string;
  /** Device type (e.g. "D", "NPN", "NMOS"). */
  type: DeviceType;
  /** Model level (1 or 2; higher levels produce diagnostics). */
  level: number;
  /** Parameter key-value pairs (keys are SPICE-standard uppercase names). */
  params: Record<string, number>;
}

// ---------------------------------------------------------------------------
// KNOWN_PARAMS — recognized parameter names per device type
// ---------------------------------------------------------------------------

/** All recognized parameter names for each device type. */
export const KNOWN_PARAMS: Record<DeviceType, Set<string>> = {
  D: new Set(Object.keys(DIODE_DEFAULTS)),
  NPN: new Set(Object.keys(BJT_NPN_DEFAULTS)),
  PNP: new Set(Object.keys(BJT_PNP_DEFAULTS)),
  NMOS: new Set(Object.keys(MOSFET_NMOS_DEFAULTS)),
  PMOS: new Set(Object.keys(MOSFET_PMOS_DEFAULTS)),
  NJFET: new Set(Object.keys(JFET_N_DEFAULTS)),
  PJFET: new Set(Object.keys(JFET_P_DEFAULTS)),
  TUNNEL: new Set(Object.keys(TUNNEL_DIODE_DEFAULTS)),
};

// ---------------------------------------------------------------------------
// Built-in default models
// ---------------------------------------------------------------------------

const BUILT_IN_DEFAULTS: Record<DeviceType, DeviceModel> = {
  D: {
    name: "__default_D",
    type: "D",
    level: 1,
    params: { ...DIODE_DEFAULTS },
  },
  NPN: {
    name: "__default_NPN",
    type: "NPN",
    level: 1,
    params: { ...BJT_NPN_DEFAULTS },
  },
  PNP: {
    name: "__default_PNP",
    type: "PNP",
    level: 1,
    params: { ...BJT_PNP_DEFAULTS },
  },
  NMOS: {
    name: "__default_NMOS",
    type: "NMOS",
    level: 1,
    params: { ...MOSFET_NMOS_DEFAULTS },
  },
  PMOS: {
    name: "__default_PMOS",
    type: "PMOS",
    level: 1,
    params: { ...MOSFET_PMOS_DEFAULTS },
  },
  NJFET: {
    name: "__default_NJFET",
    type: "NJFET",
    level: 1,
    params: { ...JFET_N_DEFAULTS },
  },
  PJFET: {
    name: "__default_PJFET",
    type: "PJFET",
    level: 1,
    params: { ...JFET_P_DEFAULTS },
  },
  TUNNEL: {
    name: "__default_TUNNEL",
    type: "TUNNEL",
    level: 1,
    params: { ...TUNNEL_DIODE_DEFAULTS },
  },
};

// ---------------------------------------------------------------------------
// ModelLibrary
// ---------------------------------------------------------------------------

/**
 * Stores user-supplied device models and provides lookup with fallback to
 * SPICE standard built-in defaults.
 */
export class ModelLibrary {
  private readonly _models = new Map<string, DeviceModel>();

  /**
   * Add or replace a user model.
   *
   * @param model - The device model to store. If a model with the same name
   *                already exists it is overwritten.
   */
  add(model: DeviceModel): void {
    this._models.set(model.name, model);
  }

  /**
   * Look up a user model by name.
   *
   * @param name - Model name (case-sensitive, e.g. "1N4148").
   * @returns The model, or `undefined` if not found.
   */
  get(name: string): DeviceModel | undefined {
    return this._models.get(name);
  }

  /**
   * Return the built-in SPICE standard default model for a device type.
   *
   * The returned object is a fresh copy — mutations do not affect the library.
   *
   * @param deviceType - One of the 7 supported device types.
   */
  getDefault(deviceType: DeviceType): DeviceModel {
    const def = BUILT_IN_DEFAULTS[deviceType];
    return {
      name: def.name,
      type: def.type,
      level: def.level,
      params: { ...def.params },
    };
  }

  /**
   * List all user-added models. Does not include built-in defaults.
   */
  getAll(): DeviceModel[] {
    return [...this._models.values()];
  }

  /**
   * Remove a user model by name.
   *
   * @param name - Model name.
   * @returns `true` if the model was found and removed; `false` if not found.
   */
  remove(name: string): boolean {
    return this._models.delete(name);
  }

  /**
   * Remove all user-added models. Built-in defaults are retained.
   */
  clear(): void {
    this._models.clear();
  }
}

// ---------------------------------------------------------------------------
// validateModel — emit diagnostics for unknown params and unsupported levels
// ---------------------------------------------------------------------------

/**
 * Validate a `DeviceModel` against the known parameter set for its device
 * type and the supported model level range.
 *
 * @param model - The model to validate.
 * @returns Array of `SolverDiagnostic` entries (empty if model is clean).
 */
export function validateModel(model: DeviceModel): SolverDiagnostic[] {
  const diagnostics: SolverDiagnostic[] = [];
  const known = KNOWN_PARAMS[model.type];

  for (const paramName of Object.keys(model.params)) {
    if (!known.has(paramName)) {
      diagnostics.push(
        makeDiagnostic(
          "model-param-ignored",
          "warning",
          `Model "${model.name}" has unknown parameter "${paramName}" for device type ${model.type} — it will be ignored`,
          {
            explanation:
              `Parameter "${paramName}" is not recognized for ${model.type} devices. ` +
              `Known parameters are: ${[...known].join(", ")}. ` +
              `The parameter will have no effect on simulation.`,
          },
        ),
      );
    }
  }

  if (model.level > 2) {
    diagnostics.push(
      makeDiagnostic(
        "model-level-unsupported",
        "error",
        `Model "${model.name}" requests Level ${model.level} equations for ${model.type}, but only Level 1 and 2 are supported`,
        {
          explanation:
            `Model level ${model.level} is not implemented. ` +
            `Level 2 equations will be used, but results will be incorrect for BSIM3/4 and Level 3+ MOSFETs. ` +
            `Use a Level 1 or Level 2 .MODEL statement instead.`,
        },
      ),
    );
  }

  return diagnostics;
}
