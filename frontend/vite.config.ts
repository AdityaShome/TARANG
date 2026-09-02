import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/

// Local development: connect frontend to the local backend
// When running in docker-compose, this must point to the service names, not localhost
const backendTarget = process.env.VITE_BACKEND_TARGET || 'http://backend:8000'
const threddsTarget = process.env.VITE_THREDDS_TARGET || 'http://thredds:8080'


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
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },

      '/thredds': {
        target: threddsTarget,
        changeOrigin: true,
      },

      '/wms': {
        target: threddsTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wms/, '/thredds/wms'),
      },

      '/wcs': {
        target: threddsTarget,
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
          three: ['three'],
          plotly: ['plotly.js-dist-min'],
          leaflet: ['leaflet'],
        },
      },
    },
  },
})