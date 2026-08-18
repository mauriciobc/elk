import { defineVitestProject } from '@nuxt/test-utils/config'
import { isCI } from 'std-env'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    'process.test': 'true',
  },
  test: {
    reporters: isCI ? ['default', 'hanging-process'] : ['default'],
    /**
     * Component tests that boot the Nuxt app (`mountSuspended`) make Nuxt's
     * router plugin walk `routes.mjs` and resolve every page's component chain.
     * When several such files run in parallel workers, one worker's still-in-
     * flight lazy import can land after another has torn its environment down,
     * which Vitest reports as an unhandled `EnvironmentTeardownError` — the run
     * then exits non-zero even though every test passed. Measured here at 2 of
     * 5 parallel runs; 0 of 4 serial.
     *
     * The cost is ~7s on a suite that finishes in seconds, which is a good
     * trade for a deterministic exit code. Revisit if the suite grows enough
     * for that to hurt — the narrower fix is a separate project for the
     * app-booting component tests, leaving the pure unit files parallel.
     */
    fileParallelism: false,
    projects: [
      await defineVitestProject({
        test: {
          name: 'nuxt',
          setupFiles: [
            '../tests/setup.ts',
          ],
          environmentOptions: {
            nuxt: {
              mock: {
                indexedDb: true,
                intersectionObserver: true,
              },
            },
          },
        },
      }),
    ],
  },
})
