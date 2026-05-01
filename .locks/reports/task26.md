# Task #26 Report- D-7: bjt.ts MODEINITSMSIG seed vbx (and vsub) from rhsOld

## Status: COMPLETE

## Changes made (bjtload.c:239-244)

Added `const rhsOld = voltages` alias (ctx.voltages IS CKTrhsOld per load-context.ts:28).

Promoted `vbx` and `vsub` to outer-scope `let` declarations, initialized from default voltage path.

In MODEINITSMSIG branch: seed vbx/vsub from rhsOld per bjtload.c:239-244.
In MODEINITTRAN branch: seed vbx/vsub from rhsOld per bjtload.c:248-253.

Removed `void vbx; void vsub; // consumed by capbx/capsub blocks when implemented` (banned excuse-framing).

## Verification

- `vbx\s*=\s*[^;]*rhsOld` in bjt.ts → 3 hits (≥1 required)
- `void vbx|void vsub|when implemented` in bjt.ts → 0 hits

## Ngspice ref
- bjtload.c:239-244 (MODEINITSMSIG vbx/vsub from CKTrhsOld)
- bjtload.c:248-253 (MODEINITTRAN vbx/vsub from CKTrhsOld)
