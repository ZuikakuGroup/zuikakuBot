import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:workers": "./test/cloudflare-workers.ts" } },
  test: { include: ["test/**/*.test.ts"] },
});
