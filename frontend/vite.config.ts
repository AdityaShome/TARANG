import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // During dev: proxy API calls to FastAPI backend
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // During dev: proxy THREDDS calls
      '/thredds': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/wms': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wms/, '/thredds/wms'),
      },
      '/wcs': {
        target: 'http://localhost:8080',
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
