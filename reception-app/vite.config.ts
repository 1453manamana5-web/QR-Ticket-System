import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {productionBrowserPolicy} from '../shared/browserPolicy';

export default defineConfig({
  plugins: [react(),productionBrowserPolicy()],
  build: {
    rollupOptions: {
      input: { reception: 'index.html', counterSync: 'src/counterSync.ts' },
      output: {entryFileNames: entry => entry.name === 'counterSync' ? 'people-counter/counter-sync.js' : 'assets/[name]-[hash].js'},
    },
  },
  base: "/QR-Ticket-System/",
});
