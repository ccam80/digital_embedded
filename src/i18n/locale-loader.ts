/**
 * Locale loader for i18n system.
 * Loads locale JSON files and caches them.
 * Supports both browser (fetch) and test environments (dynamic import).
 */

type LocaleData = Record<string, string>;

const localeCache: Map<string, LocaleData> = new Map();

// Locale modules loaded dynamically for testing
const localeModules: Record<string, () => Promise<{ default: LocaleData }>> = {
  en: () => import('./locales/en.json'),
};

/**
 * Load a locale from a JSON file.
 * Caches the result for subsequent calls.
 * Supports both browser (fetch) and test (import) environments.
 *
 * @param locale - The locale code (e.g., 'en', 'de', 'zh')
 * @returns Promise resolving to the locale data
 * @throws Error if the locale file cannot be loaded
 */
export async function loadLocale(locale: string): Promise<LocaleData> {
  // Check cache first
  if (localeCache.has(locale)) {
    return localeCache.get(locale)!;
  }

  try {
    let data: LocaleData;

    // Try to load via direct import first (for testing)
    if (localeModules[locale]) {
      const module = await localeModules[locale]();
      data = module.default;
    } else {
      // Fall back to fetch for runtime (browser)
      const response = await fetch(`/src/i18n/locales/${locale}.json`);
      if (!response.ok) {
        throw new Error(`Failed to load locale file: ${locale}.json (HTTP ${response.status})`);
      }
      data = await response.json();
    }

    localeCache.set(locale, data);
    return data;
  } catch (error) {
    throw new Error(`Failed to load locale ${locale}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Preload multiple locales into cache.
 * Useful for preloading all available locales at startup.
 *
 * @param locales - Array of locale codes to preload
 * @returns Promise that resolves when all locales are loaded
 */
export async function preloadLocales(locales: string[]): Promise<void> {
  await Promise.all(locales.map((locale) => loadLocale(locale)));
}

/**
 * Clear the locale cache.
 * Useful for testing or forcing a reload.
 */
export function clearLocaleCache(): void {
  localeCache.clear();
}

/**
 * Get the cached locale data for a locale.
 * Returns undefined if the locale is not cached.
 *
 * @param locale - The locale code
 * @returns The cached locale data, or undefined
 */
export function getCachedLocale(locale: string): LocaleData | undefined {
  return localeCache.get(locale);
}

/**
 * Register a locale module for dynamic import (used for testing).
 * This allows tests to inject locale data without requiring an HTTP server.
 *
 * @param locale - The locale code
 * @param loader - Function that returns a promise resolving to { default: LocaleData }
 */
export function registerLocaleModule(locale: string, loader: () => Promise<{ default: LocaleData }>): void {
  localeModules[locale] = loader;
}
