import { defineConfig } from "vitest/config";

// XSD validation runs via libxmljs2 (a Node.js native binding) which cannot
// load inside the @cloudflare/vitest-pool-workers runtime. We use the plain
// vitest Node pool (default "forks") for just the xsd.test.ts file.
export default defineConfig({
  test: {
    include: ["test/xsd.test.ts"],
    pool: "forks",
  },
});
