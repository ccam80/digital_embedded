import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, cpSync, statSync } from 'fs';

/**
 * Copy static asset directories and non-Vite HTML files into the build output
 * so they are available on the deployed site.
 */
function copyStaticAssets() {
  return {
    name: 'copy-static-assets',
    closeBundle() {
      // Asset directories
      const dirs = ['circuits', 'tutorials', 'modules'];
      for (const dir of dirs) {
        const src = resolve(__dirname, dir);
        const dest = resolve(__dirname, 'dist', dir);
        try {
          statSync(src);
          cpSync(src, dest, { recursive: true });
        } catch {
          // Directory doesn't exist yet — skip silently
        }
      }
      // HTML files that use inline scripts or pre-built bundles (not Vite inputs)
      const htmlFiles = ['tutorial.html', 'tutorials.html', 'tutorial-viewer.html'];
      for (const file of htmlFiles) {
        try {
          copyFileSync(resolve(__dirname, file), resolve(__dirname, 'dist', file));
        } catch {
          // File doesn't exist — skip
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
        simulator: resolve(__dirname, 'simulator.html'),
        'tutorial-editor': resolve(__dirname, 'tutorial-editor.html'),
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [copyStaticAssets()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
