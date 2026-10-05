import { defineConfig } from "vitest/config";

// The host plugin runs against the published `ace-runtime` build (the same package a user installs)
// and the published `@earendil-works/*` packages.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
