import { defineConfig } from 'vite'

export default defineConfig({
  // Fully static, zero server. Anyone can load the built site. BASE_PATH is
  // set by the GitHub Pages workflow (the site lives under /<repo>/ there).
  base: process.env.BASE_PATH ?? '/',
  server: { port: 5173, open: false },
  build: {
    target: 'es2020',
    sourcemap: false,
    minify: 'esbuild',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
  },
})
