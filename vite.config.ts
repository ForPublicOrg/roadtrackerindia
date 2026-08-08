import { defineConfig, type Plugin } from 'vite'

/**
 * `api/` holds Vercel serverless functions, which vite knows nothing about. It
 * sits inside the project root, so the dev server would happily transpile and
 * serve `/api/ratings` — handing the browser the server's own source, with a
 * 200 and a JavaScript content-type. Answering 404 instead makes `npm run dev`
 * behave like a host with no functions, which is what it actually is: use
 * `vercel dev` to exercise the real endpoints.
 *
 * Production is unaffected either way — `vite build` only emits what index.html
 * reaches, so `api/` never enters `dist/`.
 */
function noApiInDev(): Plugin {
  return {
    name: 'rti-no-api-in-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()
        res.statusCode = 404
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'no-api', hint: 'run `vercel dev` to serve api/' }))
      })
    },
  }
}

export default defineConfig({
  base: '/',
  plugins: [noApiInDev()],
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
