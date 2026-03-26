import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let backendProc = null;
const backendCwd = path.join(__dirname, '..', 'backend');
const backendEntry = path.join(backendCwd, 'server.py');
const pythonCommand = process.env.CREST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'backend-launcher',
      configureServer(server) {
        server.middlewares.use('/__start', (_req, res) => {
          const isRunning = backendProc && !backendProc.killed && backendProc.exitCode === null;
          if (!isRunning) {
            backendProc = spawn(pythonCommand, [backendEntry], {
              cwd: backendCwd,
              stdio: 'inherit',
            });
            backendProc.on('error', (err) => {
              console.error('[backend]', `${err.message}. Set CREST_PYTHON if your interpreter is not on PATH.`);
            });
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
