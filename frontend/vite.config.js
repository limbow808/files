import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let backendProc = null;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'backend-launcher',
      configureServer(server) {
        server.middlewares.use('/__start', (_req, res) => {
          const isRunning = backendProc && !backendProc.killed && backendProc.exitCode === null;
          if (!isRunning) {
            backendProc = spawn('python', [path.join(__dirname, '..', 'backend', 'server.py')], {
              cwd: path.join(__dirname, '..', 'backend'),
              stdio: 'inherit',
            });
            backendProc.on('error', (err) => console.error('[backend]', err.message));
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ started: true }));
        });
      },
    },
  ],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5001',
        changeOrigin: true,
        timeout: 0,         // no proxy-side socket timeout (for long SSE scans)
        proxyTimeout: 0,    // no timeout waiting for backend response
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
