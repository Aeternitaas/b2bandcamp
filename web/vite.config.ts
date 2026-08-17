import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The frontend is a standalone build artifact: `npm run build` emits static
// files that the Go server serves. Nothing here depends on Go at build time,
// which is what keeps the two halves decoupled.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep the initial payload small on mobile connections.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    // In dev the SPA runs on Vite and forwards API calls to the Go server.
    proxy: {
      '/api': {
        target: 'http://localhost:9185',
        changeOrigin: false,
      },
    },
  },
})
