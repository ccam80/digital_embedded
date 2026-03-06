import { describe, it, expect } from 'vitest';

describe('BrowserDepFence', () => {
  describe('headlessBarrelImportable', () => {
    it('dynamically import src/headless/index.ts, assert all expected exports exist', async () => {
      // Use dynamic import to test the barrel export
      const headless = await import('../index.js');

      // Facade and types
      expect(typeof headless.FacadeError).toBe('function');

      // Builder
      expect(typeof headless.CircuitBuilder).toBe('function');

      // Core types
      expect(typeof headless.Circuit).toBe('function');
      expect(typeof headless.Wire).toBe('function');
      expect(typeof headless.Net).toBe('function');
      expect(typeof headless.ComponentRegistry).toBe('function');

      // Render context types — these are objects, not constructors
      expect(typeof headless.defaultColorScheme).toBe('object');
      expect(typeof headless.highContrastColorScheme).toBe('object');
      expect(typeof headless.monochromeColorScheme).toBe('object');
      expect(typeof headless.COLOR_SCHEMES).toBe('object');
      expect(Array.isArray(headless.THEME_COLORS)).toBe(true);

      // Error types
      expect(typeof headless.SimulationError).toBe('function');
      expect(typeof headless.BitsException).toBe('function');
      expect(typeof headless.BurnException).toBe('function');
    });
  });
});
