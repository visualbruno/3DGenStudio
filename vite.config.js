import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /backend/* on the frontend is proxied to the backend
const backendTarget = process.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';

// Bind to all interfaces and allow any Host header only inside a container.
const inDocker = process.env.RUNNING_IN_DOCKER === '1';

const backendProxy = {
  target: backendTarget,
  changeOrigin: true,
  secure: false,
  rewrite: (path) => path.replace(/^\/backend/, ''),
}

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    host: inDocker ? '0.0.0.0' : 'localhost',
    port: 3000,
    strictPort: true,
    proxy: {
      '/backend': backendProxy,
    }
  },
  preview: {
    host: inDocker ? '0.0.0.0' : 'localhost',
    port: 3000,
    strictPort: true,
    allowedHosts: inDocker ? true : undefined,
    proxy: {
      '/backend': backendProxy,
    }
  },
  // uncomment for debugging
  // build: {
  //   minify: false,
  //   sourcemap: true,
  // },
})
