import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Emit lib/index.js (not .mjs): the package is `"type": "module"`.
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    // Every runtime import is a DSH package shipped with the Harness (declared
    // as a peerDependency) or a Node builtin; none of them may be bundled.
    neverBundle: true,
  },
})
