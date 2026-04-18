import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
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
            TEST_MIGRATIONS: migrations,
          },
        },
      },
    },
  },
});
