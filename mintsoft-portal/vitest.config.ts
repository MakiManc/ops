import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Server and library tests run in node; the component tests ask for jsdom
    // themselves with a docblock, so the default stays fast.
    environment: 'node',
  },
})
