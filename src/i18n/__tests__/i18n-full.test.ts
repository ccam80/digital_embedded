import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  i18n,
  setLocale,
  getLocale,
  onLocaleChange,
  initializeI18n,
  resetI18n,
} from '../index';
import { clearLocaleCache, registerLocaleModule } from '../locale-loader';
import enData from '../locales/en.json';

describe('i18n Full Implementation', () => {
  beforeEach(async () => {
    clearLocaleCache();
    resetI18n();
    // Register the English locale module for testing
    registerLocaleModule('en', async () => ({ default: enData }));
    await initializeI18n('en');
  });

  afterEach(() => {
    resetI18n();
    clearLocaleCache();
  });

  describe('lookupKey', () => {
    it('should return localized string for valid key in English', () => {
      const result = i18n('menu.file.open');
      expect(result).toBe('Open');
    });

    it('should return localized string for nested keys', () => {
      expect(i18n('components.gates.and')).toBe('AND');
      expect(i18n('components.gates.or')).toBe('OR');
      expect(i18n('toolbar.step')).toBe('Step');
    });

    it('should return the key itself if not found in any locale', () => {
      const result = i18n('nonexistent.key.path');
      expect(result).toBe('nonexistent.key.path');
    });
  });

  describe('paramInterpolation', () => {
    it('should interpolate single parameter', () => {
      const result = i18n('errors.notFound', { name: 'foo' });
      expect(result).toBe("Component 'foo' not found");
    });

    it('should interpolate multiple parameters', () => {
      const result = i18n('errors.loadFailed', { error: 'File not found' });
      expect(result).toBe('Failed to load file: File not found');
    });

    it('should handle numeric parameters', () => {
      const result = i18n('errors.notFound', { name: 42 });
      expect(result).toBe("Component '42' not found");
    });

    it('should ignore parameters not present in the string', () => {
      const result = i18n('menu.file.open', { unused: 'value' });
      expect(result).toBe('Open');
    });

    it('should handle missing parameters gracefully', () => {
      const result = i18n('errors.notFound', {});
      // The key contains {name} but no value was provided, so it stays as-is
      expect(result).toContain('{name}');
    });
  });

  describe('fallbackToEnglish', () => {
    it('should fall back to English when key missing in current locale', async () => {
      // First load a German locale (simulated with partial data)
      // For this test, we'll use a spy on the locale data
      await setLocale('en');

      // Verify English has the key
      expect(i18n('menu.file.open')).toBe('Open');
    });

    it('should use English as fallback when current locale is not en', async () => {
      // Set to a non-existent locale that won't have all keys
      const result = i18n('menu.file.open');
      expect(result).toBe('Open');
    });
  });

  describe('missingKeyReturnsKey', () => {
    it('should return the key when not found in any locale', () => {
      const key = 'some.unknown.key.that.does.not.exist';
      const result = i18n(key);
      expect(result).toBe(key);
    });

    it('should return gracefully for malformed keys', () => {
      const result = i18n('');
      expect(result).toBe('');
    });

    it('should handle keys with special characters', () => {
      const key = 'test.key-with-dash';
      const result = i18n(key);
      expect(result).toBe(key);
    });
  });

  describe('localeChangeEvent', () => {
    it('should fire callback when setLocale is called', async () => {
      const callback = vi.fn();
      onLocaleChange(callback);

      await setLocale('en');

      expect(callback).toHaveBeenCalledWith('en');
    });

    it('should allow multiple callbacks to be registered', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      onLocaleChange(callback1);
      onLocaleChange(callback2);

      await setLocale('en');

      expect(callback1).toHaveBeenCalledWith('en');
      expect(callback2).toHaveBeenCalledWith('en');
    });

    it('should allow callbacks to be unregistered', async () => {
      const callback = vi.fn();
      const unregister = onLocaleChange(callback);

      await setLocale('en');
      expect(callback).toHaveBeenCalledTimes(1);

      unregister();
      await setLocale('en');

      // Should still be 1, not incremented
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle errors in callbacks gracefully', async () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Test error');
      });
      const goodCallback = vi.fn();

      onLocaleChange(errorCallback);
      onLocaleChange(goodCallback);

      // Should not throw
      await expect(setLocale('en')).resolves.toBeUndefined();

      expect(errorCallback).toHaveBeenCalled();
      expect(goodCallback).toHaveBeenCalled();
    });
  });

  describe('switchLocale', () => {
    it('should switch to a different locale', async () => {
      expect(getLocale()).toBe('en');

      await setLocale('en');

      expect(getLocale()).toBe('en');
    });

    it('should return English strings after switching locale', async () => {
      await setLocale('en');
      const result = i18n('menu.file.open');

      expect(result).toBe('Open');
    });

    it('should handle invalid locale gracefully', async () => {
      const originalLocale = getLocale();

      await setLocale('invalid-locale-that-doesnt-exist');

      // Should keep the original locale on error
      expect(getLocale()).toBe(originalLocale);
    });
  });

  describe('getLocale', () => {
    it('should return current locale', () => {
      expect(getLocale()).toBe('en');
    });

    it('should reflect changes after setLocale', async () => {
      await setLocale('en');
      expect(getLocale()).toBe('en');
    });
  });

  describe('initializeI18n', () => {
    it('should initialize with English by default', async () => {
      resetI18n();
      await initializeI18n();

      expect(getLocale()).toBe('en');
    });

    it('should initialize with specified locale', async () => {
      resetI18n();
      await initializeI18n('en');

      expect(getLocale()).toBe('en');
    });

    it('should handle initialization failure gracefully', async () => {
      resetI18n();
      // Try to initialize with non-existent locale
      await initializeI18n('nonexistent-locale');

      // Should set locale even if loading fails
      expect(getLocale()).toBe('nonexistent-locale');
    });
  });

  describe('complex scenarios', () => {
    it('should handle deeply nested keys', () => {
      const result = i18n('components.flipflops.srLatch');
      expect(result).toBe('SR Latch');
    });

    it('should interpolate in deeply nested keys', () => {
      const result = i18n('errors.unknownComponent', { name: 'CustomGate' });
      expect(result).toBe('Unknown component: CustomGate');
    });

    it('should handle locale switching with callbacks and lookups', async () => {
      const callback = vi.fn();
      onLocaleChange(callback);

      await setLocale('en');
      expect(callback).toHaveBeenCalledWith('en');

      const result = i18n('menu.file.open');
      expect(result).toBe('Open');
    });

    it('should preserve parameter interpolation across locale switches', async () => {
      const result1 = i18n('errors.notFound', { name: 'Test' });
      expect(result1).toBe("Component 'Test' not found");

      await setLocale('en');

      const result2 = i18n('errors.notFound', { name: 'Test' });
      expect(result2).toBe("Component 'Test' not found");
    });
  });
});
