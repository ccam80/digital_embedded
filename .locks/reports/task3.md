# Task #3 Report- A-3 + A-4: Comment deletions in bjt.ts

## Status: COMPLETE

## Changes made

### A-3 (bjt.ts:55)
- Deleted historical-provenance comment: `// BJ1: VT import removed- all code now uses tp.vt (temperature-dependent thermal voltage)`
- Verification: `VT import removed` in bjt.ts → 0 hits

### A-4 (bjt.ts:1516)
- Replaced: `// bjtload.c:258-276: MODEINITJCT with OFF / UIC / fallback.`
- With: `// bjtload.c:258-276: MODEINITJCT dispatch- OFF branch, UIC branch, and the else (vcrit) branch.`
- Verification: `fallback` in bjt.ts → 0 hits
