import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Docker Desktop bind mounts on Windows/macOS don't reliably forward native
    // filesystem change events into the container, so Vite's default watcher misses
    // edits made from the host. Polling is slower but actually fires HMR.
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      // During dev (in Docker): use service names on the Docker network
      '/api': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
      '/thredds': {
        target: 'http://thredds:8080',
        changeOrigin: true,
      },
      '/wms': {
        target: 'http://thredds:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wms/, '/thredds/wms'),
      },
      '/wcs': {
        target: 'http://thredds:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wcs/, '/thredds/wcs'),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split Three.js into its own chunk — it's large (~1MB)
        manualChunks: {
          'three': ['three'],
          'plotly': ['plotly.js-dist-min'],
          'leaflet': ['leaflet'],
        },
      },
    },
  },
})
