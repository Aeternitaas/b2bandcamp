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
    // Bind all interfaces so the dev server is reachable from a phone on the
    // LAN, which is the whole point of testing a mobile-first UI.
    host: true,
    // In dev the SPA runs on Vite and forwards API calls to the Go server.
    // Inside docker-compose.dev the target is the api service; on a bare host
    // it is localhost.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:9185',
        changeOrigin: false,
      },
    },
    watch: {
      // Bind mounts do not always propagate inotify events into a container,
      // so allow polling to be switched on when running under Docker.
      usePolling: process.env.VITE_USE_POLLING === 'true',
      interval: 300,
    },
  },
})
