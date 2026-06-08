# Polarized-cap clamp — 1-ULP numeric divergence (shared-diagonal accumulation order)

**Category:** 1-ULP numeric (NOT a parameter-value mismatch; NOT a temp-representation bug).

**Tests (failing in the conformant no-spread state):**
- `src/components/passives/__tests__/polarized-cap.test.ts :: transient_step_end_paired_rc_charge`
- `src/components/passives/__tests__/polarized-cap.test.ts :: transient_step_end_paired_reverse_bias`

Both are ngspice parity asserts (`ComparisonSession`), failing on a per-iteration
1-ULP at iter 0, that **converges to a bit-identical result** (diode `VD/ID/GEQ`
and cBody `Q/CCAP` are bit-identical at `tranInit`).

## What it is

`PolarizedCap`'s clamp diode (`dClamp`) previously passed `...DIODE_PARAM_DEFAULTS`
as sub-element params (marked given → emitted), so the ngspice clamp `.model`
card + instance line carried the **full** diode parameter set incl. the instance
line `AREA=1 TEMP=27 pj=0 w=0 l=0 m=1`. The conformant architecture (the diode
refactor: variants/leaves get the full schema via the standard merge) makes that
spread redundant, so it was removed — leaving a sparse card `.model … D (CJO=0 TT=0)`.

Removing it flips one matrix cell by 1 ULP: the `cap_cBody` diagonal (the two
resistor stamps `1/esr + 1/rLeak` plus the cBody companion accumulating into a
shared node).

## What it is NOT (verified)

- **Not a parameter value.** Every ngspice diode default (`diosetup.c`) matches
  our `DIODE_PARAM_DEFS` (IS 1e-14, N 1, VJ 1, M .5, FC .5, EG 1.11, XTI 3,
  NTUN 30, XTITUN 3, KEG 1, NR 2, ISR 1e-14, RTH0 0, CTH0 1e-5, fv/bv/id/te_max
  1e99, …). The emitted instance params all equal ngspice defaults (value-inert).
- **Not a temp-representation bug.** `REFTEMP = 27.0 + CONSTCtoK` and
  `27 + 273.15 === 300.15` is **bit-identical** (ulp diff 0); `ctx.temp` (300.15)
  already equals ngspice `CKTtemp`. Temp is standardized and matches.

## Best current hypothesis

Emitting the diode instance params (notably setting `DIOtempGiven`) sends ngspice
down a different diode setup/element-allocation path, reordering the accumulation
of the stamps on the shared `cap_cBody` diagonal — the per-device shared-diagonal
accumulation-order effect (CLAUDE.md: 1-ULP at iter 0 on a shared diagonal is not
the sparse solver; look at per-device load()/setup() order). Not yet confirmed at
the ngspice-internal level.

## Disposition

Conformant no-spread architecture kept. The 2 tests accepted as a known 1-ULP
numeric divergence pending a deep-dive into ngspice diode setup/allocation order
vs our stamp order (escalated, not a parameter fix).
