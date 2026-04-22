/**
 * CKTmode bitfield — single source of truth for simulation mode.
 *
 * Direct port of ngspice `CKTmode` (cktdefs.h:160-209).
 *
 * Values are the exact ngspice hex constants from
 * ref/ngspice/src/include/ngspice/cktdefs.h:165-185.
 *
 * Semantics (ngspice cktdefs.h):
 *   MODE          — high-level analysis selector bits
 *     MODETRAN    (0x0001) transient analysis active       (cktdefs.h:166)
 *     MODEAC      (0x0002) AC small-signal analysis active (cktdefs.h:167)
 *     MODEDC      (0x0070) union of all DC-family modes    (cktdefs.h:170)
 *     MODEDCOP    (0x0010) standalone .OP analysis         (cktdefs.h:171)
 *     MODETRANOP  (0x0020) transient-boot DCOP             (cktdefs.h:172)
 *     MODEDCTRANCURVE (0x0040) DC sweep (.DC)              (cktdefs.h:173)
 *     MODEUIC     (0x10000) use IC (bypasses DCOP for .tran with uic=true) (cktdefs.h:185)
 *   INITF         — low-level Newton init-mode selector bits (mutually exclusive)
 *     MODEINITFLOAT (0x0100) normal linearization from previous iterate (cktdefs.h:177)
 *     MODEINITJCT   (0x0200) cold-start: seed junctions from per-device tVcrit (cktdefs.h:178)
 *     MODEINITFIX   (0x0400) post-initJct: freeze OFF devices, float others (cktdefs.h:179)
 *     MODEINITSMSIG (0x0800) AC small-signal linearization seed (cktdefs.h:180)
 *     MODEINITTRAN  (0x1000) first transient NR call after DCOP (cktdefs.h:181)
 *     MODEINITPRED  (0x2000) predictor-extrapolation linearization (cktdefs.h:182)
 *
 * INITF_MASK covers the mutually-exclusive init-mode bits; MODE_ANALYSIS_MASK
 * covers the analysis-class bits. The helpers assert mutual exclusion on
 * write.
 */

// ---- Analysis type -----------------------------------------------------------

/** Combined AC+TRAN mask (MODETRAN | MODEAC). cktdefs.h:165. */
export const MODE             = 0x3;

/** Transient analysis active. cktdefs.h:166. */
export const MODETRAN         = 0x0001;

/** AC small-signal analysis active. cktdefs.h:167. */
export const MODEAC           = 0x0002;

// ---- DC-family mask (any DC mode) --------------------------------------------

/** Union of DC-family modes (MODEDCOP | MODETRANOP | MODEDCTRANCURVE).
 *  cktdefs.h:170. Used by cktload.c:104 to gate nodeset/IC enforcement. */
export const MODEDC           = 0x0070;

/** Standalone .OP analysis. cktdefs.h:171. */
export const MODEDCOP         = 0x0010;

/** Transient-boot DC-OP (.tran precedes with MODETRANOP DCOP). cktdefs.h:172. */
export const MODETRANOP       = 0x0020;

/** DC sweep (.DC) transfer-curve mode. cktdefs.h:173. */
export const MODEDCTRANCURVE  = 0x0040;

// ---- NR init-mode phase (mutually exclusive) ---------------------------------

/** Normal linearization from previous iterate. cktdefs.h:177. */
export const MODEINITFLOAT    = 0x0100;

/** Cold-start: seed junctions from per-device tVcrit. cktdefs.h:178. */
export const MODEINITJCT      = 0x0200;

/** Post-initJct: freeze OFF devices, float others. cktdefs.h:179. */
export const MODEINITFIX      = 0x0400;

/** AC small-signal linearization seed. cktdefs.h:180. */
export const MODEINITSMSIG    = 0x0800;

/** First transient NR call after DCOP. cktdefs.h:181. */
export const MODEINITTRAN     = 0x1000;

/** Predictor-extrapolation linearization (#undef PREDICTOR => never set). cktdefs.h:182. */
export const MODEINITPRED     = 0x2000;

// ---- Orthogonal flags --------------------------------------------------------

/** Use Initial Conditions flag (bypasses DCOP for .tran with uic=true).
 *  cktdefs.h:185. Combined with MODETRANOP or MODEINITTRAN via OR. */
export const MODEUIC          = 0x10000;

// ---- Composite masks ---------------------------------------------------------

/** Mask covering all mutually-exclusive INITF bits. */
export const INITF_MASK =
  MODEINITFLOAT | MODEINITJCT | MODEINITFIX |
  MODEINITSMSIG | MODEINITTRAN | MODEINITPRED;

/** Mask covering all analysis-class bits. */
export const MODE_ANALYSIS_MASK = MODEDCOP | MODETRANOP | MODEDCTRANCURVE | MODETRAN | MODEAC;

// ---- Helpers -----------------------------------------------------------------

/** Replace only the INITF bits, preserving analysis and UIC. */
export function setInitf(mode: number, initf: number): number {
  return (mode & ~INITF_MASK) | (initf & INITF_MASK);
}

/** Replace analysis bits, preserving UIC and INITF. */
export function setAnalysis(mode: number, analysis: number): number {
  return (mode & ~MODE_ANALYSIS_MASK) | (analysis & MODE_ANALYSIS_MASK);
}

/** True if this is any kind of DC-OP (standalone .OP or transient-boot). */
export function isDcop(mode: number): boolean {
  return (mode & MODEDC) !== 0;
}

/** True if in transient analysis (MODETRAN bit set, includes MODETRANOP during boot DCOP). */
export function isTran(mode: number): boolean {
  return (mode & MODETRAN) !== 0;
}

/** True during transient-boot DCOP (MODETRANOP standalone bit set). */
export function isTranOp(mode: number): boolean {
  return (mode & MODETRANOP) !== 0;
}

/** True during AC sweeps. */
export function isAc(mode: number): boolean {
  return (mode & MODEAC) !== 0;
}

/** True when UIC bit is set. */
export function isUic(mode: number): boolean {
  return (mode & MODEUIC) !== 0;
}

/** Extract the active INITF bit. Returns 0 if none set. */
export function initf(mode: number): number {
  return mode & INITF_MASK;
}

// ---- Diagnostic decoder ------------------------------------------------------

/**
 * Decode a `cktMode` bitfield into a pipe-joined string of the `MODE*` symbol
 * names currently set, for diagnostic output (harness snapshots, convergence
 * log, error messages).
 *
 * Decoded bits (cktdefs.h:165-185):
 *   - MODETRAN         (0x0001) — cktdefs.h:166
 *   - MODEAC           (0x0002) — cktdefs.h:167
 *   - MODEDCOP         (0x0010) — cktdefs.h:171
 *   - MODETRANOP       (0x0020) — cktdefs.h:172
 *   - MODEDCTRANCURVE  (0x0040) — cktdefs.h:173
 *   - MODEINITFLOAT    (0x0100) — cktdefs.h:177
 *   - MODEINITJCT      (0x0200) — cktdefs.h:178
 *   - MODEINITFIX      (0x0400) — cktdefs.h:179
 *   - MODEINITSMSIG    (0x0800) — cktdefs.h:180
 *   - MODEINITTRAN     (0x1000) — cktdefs.h:181
 *   - MODEINITPRED     (0x2000) — cktdefs.h:182
 *   - MODEUIC          (0x10000) — cktdefs.h:185
 *
 * Multiple bits are joined with `|` in the order listed above (analysis class
 * first, then INITF, then UIC) — e.g. `"MODEDCOP|MODEINITJCT"`. Returns
 * `"MODE_NONE"` when `mode === 0` (no bits set).
 *
 * This helper is for diagnostic use only — production control flow must read
 * the bitfield directly via `initf()`, `isDcop()`, etc.
 */
export function bitsToName(mode: number): string {
  if (mode === 0) return "MODE_NONE";
  const parts: string[] = [];
  // Analysis-class bits (cktdefs.h:166-173)
  if (mode & MODETRAN)        parts.push("MODETRAN");
  if (mode & MODEAC)          parts.push("MODEAC");
  if (mode & MODEDCOP)        parts.push("MODEDCOP");
  if (mode & MODETRANOP)      parts.push("MODETRANOP");
  if (mode & MODEDCTRANCURVE) parts.push("MODEDCTRANCURVE");
  // INITF bits (cktdefs.h:177-182)
  if (mode & MODEINITFLOAT)   parts.push("MODEINITFLOAT");
  if (mode & MODEINITJCT)     parts.push("MODEINITJCT");
  if (mode & MODEINITFIX)     parts.push("MODEINITFIX");
  if (mode & MODEINITSMSIG)   parts.push("MODEINITSMSIG");
  if (mode & MODEINITTRAN)    parts.push("MODEINITTRAN");
  if (mode & MODEINITPRED)    parts.push("MODEINITPRED");
  // Orthogonal flag (cktdefs.h:185)
  if (mode & MODEUIC)         parts.push("MODEUIC");
  return parts.length > 0 ? parts.join("|") : `MODE_UNKNOWN(0x${mode.toString(16)})`;
}
