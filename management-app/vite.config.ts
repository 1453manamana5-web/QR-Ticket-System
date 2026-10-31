import { defineConfig } from "vite";
import { readdirSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(),{name:"offline-asset-manifest",closeBundle(){
    writeFileSync("dist/offline-assets.json",JSON.stringify(readdirSync("dist/assets").map(name=>"assets/"+name)));
  }}],
  base: "/QR-Ticket-System/management-app/",
});
