import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// NOT *.test.ts: `bun test` (run from repo root by `make test`) claims that
// suffix too, and would try to run this as a bun test — it fails immediately
// on `import { env, SELF } from 'cloudflare:test'`, a module bun's runner
// doesn't have. Same reason e2e/*.e2e.ts isn't *.spec.ts.
export default defineConfig({
  test: { include: ['**/*.vitest.ts'] },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
})
