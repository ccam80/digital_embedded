import { describe, it, expect } from 'vitest';

describe('BrowserDepFence', () => {
  describe('headlessBarrelImportable', () => {
    it('dynamically import src/headless/index.ts, assert all expected exports exist', async () => {
      // Use dynamic import to test the barrel export
      const headless = await import('../index.js');

      // Facade and types
      expect(headless.FacadeError).toBeDefined();
      expect(typeof headless.FacadeError).toBe('function');

      // Builder
      expect(headless.CircuitBuilder).toBeDefined();
      expect(typeof headless.CircuitBuilder).toBe('function');

      // Core types
      expect(headless.Circuit).toBeDefined();
      expect(headless.Wire).toBeDefined();
      expect(headless.Net).toBeDefined();
      expect(headless.ComponentRegistry).toBeDefined();

      // Render context types
      expect(headless.defaultColorScheme).toBeDefined();
      expect(headless.highContrastColorScheme).toBeDefined();
      expect(headless.monochromeColorScheme).toBeDefined();
      expect(headless.COLOR_SCHEMES).toBeDefined();
      expect(headless.THEME_COLORS).toBeDefined();

      // Error types
      expect(headless.SimulationError).toBeDefined();
      expect(headless.BitsException).toBeDefined();
      expect(headless.BurnException).toBeDefined();
    });
  });
});
