import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    rollupOptions: {
      input: {
        splash: resolve(__dirname, 'pages/splash.html'),
        input: resolve(__dirname, 'pages/input.html'),
        overlay: resolve(__dirname, 'pages/overlay.html'),
        control: resolve(__dirname, 'pages/control.html'),
        answer: resolve(__dirname, 'pages/answer.html'),
        settings: resolve(__dirname, 'pages/settings.html'),
        dashboard: resolve(__dirname, 'pages/dashboard.html'),
      },
    },
  },
})
