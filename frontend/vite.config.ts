import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/

// Local development: connect frontend to the local backend
const backendTarget = 'http://127.0.0.1:8000'
const threddsTarget = 'http://127.0.0.1:8080'

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