import { defineConfig } from "vite";
import { readdirSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import {productionBrowserPolicy} from '../shared/browserPolicy';

export default defineConfig({
  plugins: [react(),productionBrowserPolicy(),{name:"offline-asset-manifest",closeBundle(){
    writeFileSync("dist/offline-assets.json",JSON.stringify(readdirSync("dist/assets").map(name=>"assets/"+name)));
  }}],
  base: "/QR-Ticket-System/management-app/",
});
