import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /backend/* is proxied to the Express backend so the frontend uses relative
// paths rather than hardcoded localhost:3001 URLs.
const backendTarget = process.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';

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
    host: 'localhost',
    port: 3000,
    strictPort: true,
    proxy: {
      '/backend': backendProxy,
    }
  },
  preview: {
    host: 'localhost',
    port: 3000,
    strictPort: true,
    proxy: {
      '/backend': backendProxy,
    }
  },
  build: {
    minify: false,
    sourcemap: true,
  },
})
