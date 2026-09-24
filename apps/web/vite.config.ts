import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  envDir: resolve(appDirectory, '../..'),
  server: { port: 5173 },
});
