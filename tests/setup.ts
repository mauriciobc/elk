import { afterAll, vi } from 'vitest'

// We have TypeError: AbortSignal.timeout is not a function when running tests against masto.js v6
if (!AbortSignal.timeout) {
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('TimeoutError')), ms)
    return controller.signal
  }
}

// Booting the Nuxt app makes its router plugin walk `routes.mjs`, kicking off
// lazy imports of every page's component chain. Those keep resolving long
// after a fast test file has finished, so the worker tears the environment —
// and the RPC channel the imports still need — down underneath them, and each
// stranded import lands as an unhandled `EnvironmentTeardownError` that fails
// the run despite every test passing. Letting the module graph settle here,
// while the environment is still alive, closes that race.
afterAll(async () => {
  await vi.dynamicImportSettled()
})
