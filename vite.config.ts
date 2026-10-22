import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base '/' = served at the root of the custom domain (public/CNAME). Change if you mount it under a subpath.
export default defineConfig({
  plugins: [react()],
})
