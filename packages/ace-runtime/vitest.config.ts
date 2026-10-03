import { defineConfig } from "vitest/config";

// Tests run against the published `@earendil-works/*` packages — the same builds a user installs —
// and against this package's own sources through relative imports.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
