import { defineConfig } from 'vite';

// Relative base so the built site works from a GitHub Pages project subpath
// (https://user.github.io/repo/) without any extra configuration.
export default defineConfig({
  base: './',
  build: { target: 'es2020', assetsInlineLimit: 0 },
});
