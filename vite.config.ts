import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base '/' = served at the domain root on Forge. Change if you mount it under a subpath.
export default defineConfig({
  plugins: [react()],
})
