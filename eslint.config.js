import defaultConfig from '@epic-web/config/eslint'

/** @type {import("eslint").Linter.Config} */
export default [
	...defaultConfig,
	{
		// automation/ is a standalone toolchain (own package.json, no shared
		// tsconfig); schwab-bridge.js is a legacy stdio bridge kept for reference
		ignores: ['./.wrangler/**', './automation/**', './schwab-bridge.js'],
	},
]
