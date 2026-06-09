import { defineConfig } from 'vite';
import { resolve, sep } from 'path';
import { copyFileSync, cpSync, mkdirSync, statSync, readFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Serve the repo-root `lib/` tree (e.g. `lib/74xx/*.dig`) over the dev server.
 * It lives outside `publicDir`, so without this middleware a request for
 * `/lib/74xx/7400.dig` resolves to the SPA catch-all index.html and the
 * .dig loader receives HTML. `copyStaticAssets` mirrors `lib/` into `dist/`
 * for builds.
 *
 * A missing file under `/lib/` returns 404 (never index.html): the .dig
 * subcircuit loader relies on a not-found response to skip Digital built-in
 * pseudo-elements such as `PowerSupply` that have no backing file
 * (subcircuit-loader.ts → HttpResolver throws ResolverNotFoundError on !ok).
 * Serving index.html instead would hand it HTML and break the parse.
 */
function serveLibDev() {
  return {
    name: 'serve-lib-dev',
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      const base = resolve(__dirname, 'lib');
      server.middlewares.use((req, res, next) => {
        const url: string | undefined = req.url;
        if (!url) return next();
        const pathname = decodeURIComponent(url.split('?')[0]);
        if (!pathname.startsWith('/lib/')) return next();
        const filePath = resolve(__dirname, '.' + pathname);
        const send404 = () => { res.statusCode = 404; res.end('Not found'); };
        // Path-traversal guard: resolved file must stay within `lib/`.
        if (filePath !== base && !filePath.startsWith(base + sep)) return send404();
        try {
          const data = readFileSync(filePath);
          if (filePath.endsWith('.dig')) res.setHeader('Content-Type', 'application/xml');
          res.end(data);
        } catch {
          send404();
        }
      });
    },
  };
}

/**
 * Copy static asset directories and non-Vite HTML files into the build output
 * so they are available on the deployed site.
 */
function copyStaticAssets() {
  return {
    name: 'copy-static-assets',
    closeBundle() {
      // Asset directories
      const dirs = ['circuits', 'tutorials', 'modules', 'lib'];
      for (const dir of dirs) {
        const src = resolve(__dirname, dir);
        const dest = resolve(__dirname, 'dist', dir);
        try {
          statSync(src);
          cpSync(src, dest, { recursive: true });
        } catch {
          // Directory doesn't exist yet- skip silently
        }
      }
      // HTML files that use inline scripts (not Vite inputs)
      const htmlFiles = ['app/tutorial/index.html', 'app/tutorial/view.html'];
      for (const file of htmlFiles) {
        try {
          const dest = resolve(__dirname, 'dist', file);
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(resolve(__dirname, file), dest);
        } catch {
          // File doesn't exist- skip
        }
      }
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'tutorial-edit': resolve(__dirname, 'app/tutorial/edit.html'),
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [serveLibDev(), copyStaticAssets()],
  server: {
    // The ngspice reference tree (`ref/`) sits in the working dir and carries a
    // Visual Studio `.vs/` index whose `.vsidx` files are intermittently locked.
    // Vite's recursive FSWatcher emits an unhandled EBUSY `error` watching them
    // and the dev-server process exits, taking every in-flight e2e test with it.
    // None of `ref/` is an app input, so exclude it (and any `.vs/`) from watch.
    watch: {
      ignored: ['**/ref/**', '**/.vs/**'],
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
