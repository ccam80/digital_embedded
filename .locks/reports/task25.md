# Task #25 Report — D-6: bjt.ts UIC branch use === MODETRANOP form

## Status: COMPLETE (already correct — no edit needed)

## Findings

The spec requires the UIC branch to use `=== MODETRANOP` explicit bit-equality form per bjtload.c:579-587.

Inspection of bjt.ts lines 1873-1874 shows:
```
if ((mode & MODEINITSMSIG) !== 0 &&
    !(((mode & MODETRANOP) === MODETRANOP) && (mode & MODEUIC) !== 0)) {
```

This already uses the required `=== MODETRANOP` form.

## Verification

- `(mode & MODETRANOP) &&` (truthy coercion form) in bjt.ts → 0 hits

Spec-aligned state confirmed. No edit required.
