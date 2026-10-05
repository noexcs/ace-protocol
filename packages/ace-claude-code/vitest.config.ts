import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against this package's own sources (relative imports) and the vendored `ace-runtime`
// build through this alias — no host, no broker, no model. The core is not a dependency (see
// tsconfig.json), so the bare specifier resolves to the vendored copy at test time.
export default defineConfig({
	resolve: {
		alias: {
			"ace-runtime": fileURLToPath(new URL("./vendor/ace-runtime/dist/index.js", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 15000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
