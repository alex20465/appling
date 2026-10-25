import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    root: 'src/window',
    plugins: [react()],
    build: { outDir: '../../dist/window', emptyOutDir: true, chunkSizeWarningLimit: 2500 }
});
