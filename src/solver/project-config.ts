/**
 * Project-wide solver / engine configuration knobs that map to ngspice
 * compile-time defines. These are set at the project level (not per-circuit
 * or per-instance) to mirror the way ngspice exposes them: as build flags
 * that affect the entire library.
 *
 * Use `getProjectConfig()` from inside the solver to read the active value.
 * Tests / harness setup may call `setProjectConfig({ ... })` to flip a knob,
 * and `resetProjectConfig()` in afterEach to restore defaults.
 */

export type MarkowitzVariant = 'conventional' | 'modified';

export interface ProjectConfig {
  /**
   * Markowitz pivot selection algorithm- ngspice MODIFIED_MARKOWITZ flag
   * (spconfig.h:211, default NO).
   *
   *   'conventional'- MODIFIED_MARKOWITZ NO. ngspice's documented default
   *                    and the path compiled into the bundled shared DLL
   *                    (ref/ngspice/visualc-shared/sharedspice.vcxproj has
   *                    no MODIFIED_MARKOWITZ override). QuicklySearchDiagonal
   *                    is single-pass: the first diagonal whose final
   *                    RelThreshold check passes wins. No tie tracking, no
   *                    ratio-based tie-break.
   *
   *   'modified'    - MODIFIED_MARKOWITZ YES. QuicklySearchDiagonal
   *                    collects up to MAX_MARKOWITZ_TIES candidates at the
   *                    minimum MarkowitzProduct, then picks the one with
   *                    the smallest LargestInCol/Magnitude ratio. Stronger
   *                    numerical-stability tie-break, more compute per
   *                    pivot search (calls FindBiggestInColExclude on every
   *                    tied element instead of once at the end).
   *
   * Default is 'modified' to preserve digiTS's historical behaviour. Flip
   * to 'conventional' to align bit-exact with the bundled ngspice DLL on
   * pivot-order-sensitive circuits.
   */
  markowitz: MarkowitzVariant;
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  markowitz: 'modified',
};

let active: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG };

export function getProjectConfig(): Readonly<ProjectConfig> {
  return active;
}

export function setProjectConfig(patch: Partial<ProjectConfig>): void {
  active = { ...active, ...patch };
}

export function resetProjectConfig(): void {
  active = { ...DEFAULT_PROJECT_CONFIG };
}
