import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/client.ts',
    'src/api.ts',
    'src/query.ts',
    'src/mutation.ts',
    'src/hooks.ts',
    'src/query-client.ts',
    'src/prefetch.ts',
    'src/sse.ts',
  ],
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: true,
  unbundle: true,
  treeshake: true,
  minify: false,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@tanstack/react-query',
    ],
  },
});
