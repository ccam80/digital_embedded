import { describe, it, expect } from 'vitest';
import { AnalogRateController } from '../analog-rate-controller';

describe('AnalogRateController', () => {
  // -----------------------------------------------------------------------
  // computeFrameTarget
  // -----------------------------------------------------------------------

  describe('computeFrameTarget', () => {
    it('scales target sim-advance by rate × wallDt', () => {
      const ctrl = new AnalogRateController({ targetRate: 1e-3 });
      const { targetSimAdvance } = ctrl.computeFrameTarget(1 / 60);
      // 1e-3 * (1/60) ≈ 1.667e-5
      expect(targetSimAdvance).toBeCloseTo(1e-3 / 60, 10);
    });

    it('clamps wallDt to 100 ms to avoid jumps after tab-away', () => {
      const ctrl = new AnalogRateController({ targetRate: 1e-3 });
      // Simulate 2 seconds of wall time (tab was backgrounded)
      const { targetSimAdvance } = ctrl.computeFrameTarget(2.0);
      // Should use 0.1 s, not 2.0 s
      expect(targetSimAdvance).toBeCloseTo(1e-3 * 0.1, 10);
    });

    it('returns configured budget', () => {
      const ctrl = new AnalogRateController({ maxBudgetMs: 8 });
      expect(ctrl.computeFrameTarget(0.016).budgetMs).toBe(8);
    });

    it('returns zero advance when rate is zero', () => {
      const ctrl = new AnalogRateController({ targetRate: 0 });
      expect(ctrl.computeFrameTarget(0.016).targetSimAdvance).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // targetRate property
  // -----------------------------------------------------------------------

  describe('targetRate', () => {
    it('can be updated after construction', () => {
      const ctrl = new AnalogRateController({ targetRate: 1e-3 });
      ctrl.targetRate = 1e-2;
      const { targetSimAdvance } = ctrl.computeFrameTarget(1.0);
      // clamped wallDt = 0.1, so 1e-2 * 0.1 = 1e-3
      expect(targetSimAdvance).toBeCloseTo(1e-3, 10);
    });

    it('clamps negative rates to zero', () => {
      const ctrl = new AnalogRateController();
      ctrl.targetRate = -5;
      expect(ctrl.targetRate).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // recordFrame — miss tracking & warning
  // -----------------------------------------------------------------------

  describe('recordFrame', () => {
    it('starts with warning inactive', () => {
      const ctrl = new AnalogRateController();
      expect(ctrl.isWarningActive).toBe(false);
    });

    it('activates warning when miss rate exceeds threshold', () => {
      const ctrl = new AnalogRateController({
        missThreshold: 0.3,
        clearThreshold: 0.2,
        windowMs: 1000,
      });

      // Record 10 frames, 4 missed → 40% > 30% threshold
      let lastResult;
      for (let i = 0; i < 10; i++) {
        lastResult = ctrl.recordFrame(100 + i * 16, i < 4);
      }
      expect(lastResult!.warningActive).toBe(true);
      expect(ctrl.isWarningActive).toBe(true);
    });

    it('does not activate warning below threshold', () => {
      const ctrl = new AnalogRateController({
        missThreshold: 0.3,
        clearThreshold: 0.2,
        windowMs: 1000,
      });

      // Record 10 frames, last 2 missed → never exceeds 30% at any point
      // (hits first, misses at end: 0/1, 0/2, ... 0/8, 1/9, 2/10 = 20%)
      let lastResult;
      for (let i = 0; i < 10; i++) {
        lastResult = ctrl.recordFrame(100 + i * 16, i >= 8);
      }
      expect(lastResult!.warningActive).toBe(false);
    });

    it('clears warning with hysteresis (below clearThreshold)', () => {
      const ctrl = new AnalogRateController({
        missThreshold: 0.3,
        clearThreshold: 0.2,
        windowMs: 10000,
      });

      // First: activate the warning with 50% miss rate
      for (let i = 0; i < 10; i++) {
        ctrl.recordFrame(100 + i * 16, i % 2 === 0);
      }
      expect(ctrl.isWarningActive).toBe(true);

      // Now add many hits to drop below clearThreshold (20%)
      // After 10 misses in 10 frames, add 50 hits → 10/60 ≈ 17% < 20%
      let result;
      for (let i = 0; i < 50; i++) {
        result = ctrl.recordFrame(300 + i * 16, false);
      }
      expect(result!.warningActive).toBe(false);
      expect(ctrl.isWarningActive).toBe(false);
    });

    it('does not clear warning between clearThreshold and missThreshold', () => {
      const ctrl = new AnalogRateController({
        missThreshold: 0.3,
        clearThreshold: 0.2,
        windowMs: 10000,
      });

      // Activate: 5 misses in 10 frames → 50%
      for (let i = 0; i < 10; i++) {
        ctrl.recordFrame(100 + i * 16, i < 5);
      }
      expect(ctrl.isWarningActive).toBe(true);

      // Add hits to bring miss rate to ~25% (between 20% and 30%)
      // 5 misses in 10 frames + 10 hits = 5/20 = 25%
      for (let i = 0; i < 10; i++) {
        ctrl.recordFrame(300 + i * 16, false);
      }
      // Still active — hysteresis band
      expect(ctrl.isWarningActive).toBe(true);
    });

    it('reports warningChanged only on transitions', () => {
      const ctrl = new AnalogRateController({
        missThreshold: 0.3,
        clearThreshold: 0.2,
        windowMs: 1000,
      });

      // All hits — no change
      const r1 = ctrl.recordFrame(100, false);
      expect(r1.warningChanged).toBe(false);

      // Flood misses to trigger
      let activated = false;
      for (let i = 0; i < 20; i++) {
        const r = ctrl.recordFrame(200 + i * 16, true);
        if (r.warningChanged && r.warningActive) activated = true;
      }
      expect(activated).toBe(true);

      // Sustained misses — no further change
      const r2 = ctrl.recordFrame(600, true);
      expect(r2.warningChanged).toBe(false);
      expect(r2.warningActive).toBe(true);
    });

    it('prunes frames outside the sliding window', () => {
      const ctrl = new AnalogRateController({
        missThreshold: 0.3,
        windowMs: 100,
      });

      // All misses at t=0..50
      for (let i = 0; i < 4; i++) {
        ctrl.recordFrame(i * 16, true);
      }

      // All hits at t=200..300 (old misses should be pruned)
      let result;
      for (let i = 0; i < 8; i++) {
        result = ctrl.recordFrame(200 + i * 16, false);
      }
      // After pruning, only the recent hits remain
      expect(result!.missRate).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // reset
  // -----------------------------------------------------------------------

  describe('reset', () => {
    it('clears frame history and warning', () => {
      const ctrl = new AnalogRateController({
        missThreshold: 0.3,
        windowMs: 10000,
      });

      // Activate warning
      for (let i = 0; i < 10; i++) {
        ctrl.recordFrame(100 + i * 16, true);
      }
      expect(ctrl.isWarningActive).toBe(true);

      ctrl.reset();
      expect(ctrl.isWarningActive).toBe(false);

      // Next frame starts clean
      const r = ctrl.recordFrame(500, false);
      expect(r.missRate).toBe(0);
      expect(r.warningActive).toBe(false);
    });
  });
});
