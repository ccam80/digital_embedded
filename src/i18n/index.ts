/**
 * Internationalization (i18n) module.
 *
 * Currently a pass-through implementation that returns keys unchanged.
 * Phase 9 will replace with locale-aware string lookup.
 */

let currentLocale = 'en';

/**
 * i18n function for UI strings.
 * Currently returns the key unchanged (pass-through).
 * Phase 9 will replace with locale-aware lookup.
 *
 * @param key - The localization key (e.g., 'menu.file.open')
 * @param params - Optional parameters for interpolation (currently ignored)
 * @returns The key unchanged in pass-through mode
 */
export function i18n(key: string, params?: Record<string, string | number>): string {
  return key;
}

/**
 * Set the current locale.
 * Currently a no-op; stores the locale for future use in Phase 9.
 *
 * @param locale - The locale code (e.g., 'en', 'de', 'fr')
 */
export function setLocale(locale: string): void {
  currentLocale = locale;
}

/**
 * Get the current locale.
 *
 * @returns The current locale code
 */
export function getLocale(): string {
  return currentLocale;
}
