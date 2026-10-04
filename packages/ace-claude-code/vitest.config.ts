import { defineConfig } from "vitest/config";

// Tests run against this package's own sources (relative imports) and the vendored `ace-runtime`
// barrel through its `file:` dependency — no host, no broker, no model.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 15000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
