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
   * Default is 'conventional' to match ngspice's build: spconfig.h:211 defines
   * `MODIFIED_MARKOWITZ NO`, so the shared library compiles the conventional
   * QuicklySearchDiagonal (spfactor.c:1468, the `#else` arm). Bit-exact parity
   * requires the same variant; the two diverge only on Markowitz ties (e.g. the
   * symmetric V1-branch tie in a diode bridge), where they break the tie in
   * opposite directions and pick a different pivot.
   */
  markowitz: MarkowitzVariant;
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  markowitz: 'conventional',
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
