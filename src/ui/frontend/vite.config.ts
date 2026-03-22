import { defineConfig } from "npm:vite@^5";
import preact from "npm:@preact/preset-vite@^2";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
