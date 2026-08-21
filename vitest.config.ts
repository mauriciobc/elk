import { defineVitestProject } from '@nuxt/test-utils/config'
import { isCI } from 'std-env'
import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    'process.test': 'true',
  },
  test: {
    reporters: isCI ? ['default', 'hanging-process'] : ['default'],
    /**
     * Nested git worktrees (e.g. `.claude/worktrees/*`) hold full copies of
     * this repo, and the default include glob matches their test files too.
     * Those copies fail to even load — no `.nuxt` tsconfig of their own — and
     * each shows up as a failed suite with zero tests, plus stray
     * `EnvironmentTeardownError`s from their lazy imports landing after
     * another file's environment is gone. Excluded here so a leftover
     * worktree can never poison a run again.
     */
    exclude: [...defaultExclude, '.claude/**'],
    /**
     * Component tests that boot the Nuxt app (`mountSuspended`) make Nuxt's
     * router plugin walk `routes.mjs` and resolve every page's component chain.
     * When several such files run in parallel workers, one worker's still-in-
     * flight lazy import can land after another has torn its environment down,
     * which Vitest reports as an unhandled `EnvironmentTeardownError` — the
     * run then exits non-zero even though every test passed.
     *
     * Serialization alone did not fully close that race (stray imports still
     * outlived a fast file's environment), so `tests/setup.ts` also awaits
     * `vi.dynamicImportSettled()` in an `afterAll`, letting the route graph
     * finish resolving before teardown. Keep both: this bounds the blast
     * radius to one worker at a time, that settles what remains.
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
