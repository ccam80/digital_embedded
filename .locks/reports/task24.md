# Task #24 Report- D-5: bjt.ts:1789 remove dt>0 from capGate

## Status: COMPLETE (already correct- no edit needed)

## Findings

The spec requires removing `dt > 0` from the capGate guard at bjt.ts:1789 per bjtload.c:561-563.

Inspection of the file shows the guard is already:
```
if (capGate) {
```
with no `dt > 0` condition. The capGate definition at lines 1783-1786:
```
const capGate =
  (mode & (MODETRAN | MODEAC)) !== 0 ||
  ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0) ||
  (mode & MODEINITSMSIG) !== 0;
```

## Verification

- `capGate.*dt > 0` in bjt.ts → 0 hits
- `dt > 0` in bjt.ts → 0 hits
- `capGate && dt\s*>\s*0` → 0 hits

The fix was already applied by a prior agent. Spec-aligned state confirmed.
