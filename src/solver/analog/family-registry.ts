import type { DeviceFamily } from "./ngspice-load-order.js";
import type { AnalogElement } from "./element.js";
import { IndFamilyLoadHandler } from "./loaders/ind-family-loader.js";
import { IndFamilyStampAcHandler } from "./loaders/ind-family-ac-loader.js";
import { IndFamilyTempHandler } from "./loaders/ind-family-temperature.js";

/**
 * The three per-type orchestration callbacks mirroring ngspice's
 * DEVload / DEVacLoad / DEVtemperature function-pointer slots
 * (cktload.c:61-75, acan.c:409-414, ckttemp.c:28-33).
 */
export type FamilyCallback = "load" | "stampAc" | "computeTemperature";

/**
 * A family handler encapsulates all multi-pass logic for a (family, callback)
 * pair. The `run` method receives the full ordered bucket for the family and
 * whatever context object the orchestrator passes (LoadContext, AcLoadContext,
 * or TempContext). Typed as `unknown` here so the registry is context-agnostic;
 * concrete handlers narrow the type internally.
 *
 * cite: cktload.c:61-75 — DEVices[i]->DEVload(ckt) loop structure.
 */
export interface FamilyHandler {
  /** Run this callback for every instance in the bucket, with whatever
   *  multi-pass structure the family requires. */
  run(ctx: unknown, instances: readonly AnalogElement[]): void;
}

/**
 * Global family-callback registry. Maps each DeviceFamily to a partial record
 * of (FamilyCallback → FamilyHandler) overrides.
 *
 * Any (family, callback) pair absent from the registry falls back to the
 * default per-instance handler in `loaders/default-loaders.ts`.
 *
 * Implemented as a Map (not a plain object) so tests can mutate entries via
 * standard Map operations.
 */
export const FAMILY_REGISTRY: Map<DeviceFamily, Partial<Record<FamilyCallback, FamilyHandler>>> = new Map();

FAMILY_REGISTRY.set("IND", {
  load: IndFamilyLoadHandler,
  stampAc: IndFamilyStampAcHandler,
  computeTemperature: IndFamilyTempHandler,
});
