# Wave 10 — Extended Capabilities (MEDIUM)

Implementation spec for items 9.1-9.4 from ALIGNMENT-DIFFS.md.

## 9.1 NEWTRUNC Voltage-Based LTE

File: `src/solver/analog/ckt-terr.ts`

Add voltage-domain divided differences alongside charge-based LTE:
```typescript
function cktTerrVoltage(
  vNow: number, v1: number, v2: number, v3: number,
  dt: number, deltaOld: readonly number[],
  order: number, method: IntegrationMethod,
  lteReltol: number, lteAbstol: number,
  trtol: number,
): number {
  // Same divided-difference algorithm as charge-based CKTterr
  // but using voltage values and lteReltol/lteAbstol tolerances
}
```

Parameters: `lteReltol` (1e-3), `lteAbstol` (1e-6) — from SimulationParams (added in Wave 8).

## 9.2 GEAR Integration Orders 3-6

File: `src/solver/analog/integration.ts`

Extend `computeNIcomCof()` (from Wave 5) for GEAR 3-6:
- General GEAR: solve (order+1) x (order+1) Vandermonde system
- Add `"gear"` to IntegrationMethod union
- Add GEAR LTE factors for orders 3-6 in `ckt-terr.ts`

## 9.3 State Arrays: 4 -> 8

File: `src/solver/analog/state-pool.ts`

Change constructor to allocate 8 arrays. Add accessors `state4..state7`. Update `rotateStateVectors` to rotate all 8.

## 9.4 Device Bypass Check

File: `src/core/analog-types.ts`

Add to `AnalogElementCore`:
```typescript
shouldBypass?(voltages: Float64Array, prevVoltages: Float64Array): boolean;
```

In `stampAll()` (Wave 1), check `shouldBypass()` before device evaluation.

## Dependencies

- 9.1: Independent after Wave 5 (needs centralized ag[])
- 9.2: Depends on Wave 5 + 9.3
- 9.3: Independent
- 9.4: Depends on Wave 1 (unified CKTload)
