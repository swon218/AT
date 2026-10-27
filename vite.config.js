import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': process.env.ATLAS_DEV_API_TARGET || 'http://127.0.0.1:3000' },
  },
})
