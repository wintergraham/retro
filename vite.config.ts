import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// HTTPS in dev so phones on the LAN get a secure context (needed for tilt + wake lock).
export default defineConfig({
  // HTTP=1 serves plain http on 5174 for the laptop host page: localhost is already a secure
  // context, and browsers that refuse self-signed certs (like Ask) can open it.
  plugins: process.env.HTTP ? [react()] : [react(), basicSsl()],
  define: process.env.HTTP ? { 'import.meta.env.VITE_PHONE_PORT': JSON.stringify('5173') } : {},
  server: {
    port: process.env.HTTP ? 5174 : 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/api': { target: 'http://localhost:3001' },
    },
  },
})
