import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the UI on :5175 and forwards API calls to the local gateway (./scripts/dev.sh start).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: { '/v1': process.env.API_TARGET ?? 'http://localhost:8090' },
  },
});
