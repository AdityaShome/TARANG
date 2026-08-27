import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
// Proxy targets default to Docker Compose service names; override with
// VITE_BACKEND_HOST / VITE_THREDDS_HOST for standalone (non-Docker) dev.
const backendTarget = `http://${process.env.VITE_BACKEND_HOST || 'backend:8000'}`
const threddsTarget = `http://${process.env.VITE_THREDDS_HOST || 'thredds:8080'}`

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
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
          'three': ['three'],
          'plotly': ['plotly.js-dist-min'],
          'leaflet': ['leaflet'],
        },
      },
    },
  },
})
