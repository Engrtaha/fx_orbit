import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Bind the IPv4 loopback as well: on the default 'localhost' Vite answers only
  // on ::1 here, so a client that resolves localhost to 127.0.0.1 gets refused
  // mid-page-load and ends up with a half-styled app. strictPort makes a second
  // `npm run dev` fail loudly instead of silently hopping to 5174 and shadowing
  // this one (which is how a stale instance once hid the bridge).
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
