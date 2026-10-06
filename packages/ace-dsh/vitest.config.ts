import { defineConfig } from "vitest/config";

// The plugin runs against the *vendored* `ace-runtime` build — the same code a user installs — imported by
// relative path, exactly as the plugin itself imports it. No alias is needed, and no core dependency is
// declared: `vendor/` is the core, copied by `npm run sync:vendor`.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
