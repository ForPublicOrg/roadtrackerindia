import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    sourcemap: false,
    assetsInlineLimit: 4096,
  },
  server: {
    port: 5173,
  },
})
