import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import config from './vite.config.js';

// The browser only demo served by the landing site at /ide/: the same client with the server calls answered in the page
export default mergeConfig(config, defineConfig({
    base: '/ide/',
    resolve: { alias: [{ find: /^\.\/api\.js$/, replacement: fileURLToPath(new URL('src/demo/api.ts', import.meta.url)) }] },
    build: { outDir: '../../dist/demo' }
}));
