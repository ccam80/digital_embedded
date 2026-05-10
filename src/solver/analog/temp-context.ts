/**
 * TempContext- ambient and reference temperatures passed to DEVtemperature callbacks.
 *
 * Matches the ngspice CKT fields read by every surveyed DEVtemperature
 * implementation (ckttemp.c:28-33, mos1temp.c:44-289, bjttemp.c, diotemp.c,
 * jfettemp.c, muttemp.c:35-41). No surveyed device reads CKTtime or CKTmode
 * in its temperature callback, so those fields are not included here.
 * Add fields only when a real device requires them.
 *
 * Spec ref: spec/refactor-per-type-orchestration.md §4.2 / §4.3
 */
export interface TempContext {
  /** Ambient circuit temperature in Kelvin (ngspice: CKTtemp). */
  cktTemp: number;
  /** Nominal (reference) temperature in Kelvin (ngspice: CKTnomTemp). */
  cktNomTemp: number;
}
