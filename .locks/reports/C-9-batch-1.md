## C-9-batch-1: Migrate 7 test files to cktMode bitfield

Migrated all 7 test files: spark-gap.test.ts, ntc-thermistor.test.ts, memristor.test.ts, analog-fuse.test.ts, variable-rail.test.ts, ground.test.ts, dc-voltage-source.test.ts.
Removed: iteration, initMode, isDcOp, isTransient, isTransientDcop, isAc from all LoadContext literals.
Added cktMode bitfield using MODEDCOP/MODETRAN | MODEINITFLOAT/MODEINITTRAN/MODEINITJCT as appropriate. Added ckt-mode.js imports to each file.
Verification grep: (iteration|isDcOp|isTransient|isTransientDcop|isAc)\s*: → 0 hits across all 7 files.
