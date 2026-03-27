/**
 * Run both Vitest and Playwright test suites sequentially.
 * Always runs both even if the first fails. Exits non-zero if either fails.
 */
import { spawnSync } from 'child_process';

const vitest = spawnSync('npx', ['vitest', 'run'], { stdio: 'inherit', shell: true });
const playwright = spawnSync('npx', ['playwright', 'test'], { stdio: 'inherit', shell: true });

process.exit(vitest.status || playwright.status);
