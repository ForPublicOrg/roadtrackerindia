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
    // honour PORT so tooling can hand us a free port (two dev servers at once)
    port: Number(process.env.PORT) || 5173,
  },
})
