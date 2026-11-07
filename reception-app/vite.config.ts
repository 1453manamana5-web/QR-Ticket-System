import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {productionBrowserPolicy} from '../shared/browserPolicy';

export default defineConfig({
  plugins: [react(),productionBrowserPolicy()],
  base: "/QR-Ticket-System/",
});
