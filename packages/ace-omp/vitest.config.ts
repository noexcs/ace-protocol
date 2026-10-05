import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The host plugin runs against the vendored `ace-runtime` build (the same code a user installs) and the
// published `@earendil-works/*` packages. The core is not a dependency — see tsconfig.json — so the bare
// specifier resolves through this alias at test time.
export default defineConfig({
	resolve: {
		alias: {
			"ace-runtime": fileURLToPath(new URL("./vendor/ace-runtime/dist/index.js", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
