import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'

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
  const demoCoverage = () => {
    const files = ['network-lite.geojson', 'network-detail.geojson']
    const roads = files.flatMap((file) => {
      const text = readFileSync(new URL(`./public/data/${file}`, import.meta.url), 'utf8')
      return (JSON.parse(text) as { features: { properties: { id: string } }[] }).features
    })
      // A stable sample gives the coverage switch a useful local preview while
      // keeping live totals exclusively in Firestore.
      .filter((_, i) => i % 7 === 0)
      .map((f, i) => ({
        roadId: f.properties.id,
        mean: [1.8, 2.4, 3, 3.7, 4.4][i % 5],
        votes: 3 + ((i * 7) % 18),
      }))
    return { roads, totalRatings: roads.reduce((total, road) => total + road.votes, 0), demo: true }
  }

  return {
    name: 'rti-no-api-in-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()
        if (req.url.startsWith('/api/ratings?coverage=1')) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, ...demoCoverage() }))
          return
        }
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
