import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    root: 'src/client',
    publicDir: '../../public',
    plugins: [react()],
    build: { outDir: '../../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 6000 }
});
