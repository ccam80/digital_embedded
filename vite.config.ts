import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, cpSync, mkdirSync, statSync } from 'fs';
import { dirname } from 'path';

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
      // HTML files that use inline scripts (not Vite inputs)
      const htmlFiles = ['app/tutorial/index.html', 'app/tutorial/view.html'];
      for (const file of htmlFiles) {
        try {
          const dest = resolve(__dirname, 'dist', file);
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(resolve(__dirname, file), dest);
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
        main: resolve(__dirname, 'index.html'),
        'tutorial-edit': resolve(__dirname, 'app/tutorial/edit.html'),
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
