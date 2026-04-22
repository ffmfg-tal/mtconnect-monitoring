import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    exclude: ["test/xsd.test.ts", "node_modules/**"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["DB"],
          d1Persist: false,
          bindings: {
            EDGE_SHARED_SECRET: "test-secret",
            EDGE_TUNNEL_HOSTNAME: "edge.example.internal",
          },
        },
      },
    },
  },
});
