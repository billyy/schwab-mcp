#!/usr/bin/env node
/**
 * Locate mcp-remote's on-disk OAuth state for a given server URL.
 *
 * mcp-remote keys its state files by `md5(<exact server URL string>)` and puts
 * them in a directory named after an internal version constant that LAGS the
 * published package version (package 0.1.38 writes to `mcp-remote-0.1.37`).
 * Both facts make hardcoding a path a latent breakage, so resolve it here and
 * let every caller — TS and bash — share one implementation.
 *
 * Usage as a module:
 *   import { serverUrlHash, findStateFile, findTokensFile } from './mcpRemotePaths.mjs'
 *
 * Usage from bash:
 *   node automation/mcpRemotePaths.mjs --tokens-file "$WORKER_URL/mcp"
 *     → prints the path and exits 0, or prints nothing and exits 1 if absent
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Root of mcp-remote's state tree. Mirrors its getConfigDir(). */
export function configRoot() {
	return process.env.MCP_REMOTE_CONFIG_DIR ?? join(homedir(), '.mcp-auth')
}

/**
 * mcp-remote's getServerUrlHash(): md5 of the URL, plus `|<resource>` and
 * `|<sorted header JSON>` only when --resource / --header are used. We pass
 * neither, so the URL alone is the input — but it must match byte for byte,
 * which is why callers share one WORKER_URL (see env.sh).
 */
export function serverUrlHash(serverUrl) {
	return createHash('md5').update(serverUrl).digest('hex')
}

/**
 * Newest `<hash>_<suffix>` across every `mcp-remote-*` directory. Globbing the
 * version segment is what survives an mcp-remote upgrade renaming it.
 */
export function findStateFile(serverUrl, suffix) {
	const root = configRoot()
	const hash = serverUrlHash(serverUrl)
	let dirs
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory() && e.name.startsWith('mcp-remote-'))
			.map((e) => join(root, e.name))
	} catch {
		return null // no ~/.mcp-auth at all — never authorized on this machine
	}

	let best = null
	for (const dir of dirs) {
		const candidate = join(dir, `${hash}_${suffix}`)
		try {
			const { mtimeMs } = statSync(candidate)
			if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs }
		} catch {
			// not in this version dir; keep looking
		}
	}
	return best
}

export function findTokensFile(serverUrl) {
	return findStateFile(serverUrl, 'tokens.json')
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [flag, serverUrl] = process.argv.slice(2)
	if (!serverUrl || !flag?.startsWith('--')) {
		console.error('usage: mcpRemotePaths.mjs --tokens-file|--hash <server-url>')
		process.exit(2)
	}
	if (flag === '--hash') {
		console.log(serverUrlHash(serverUrl))
		process.exit(0)
	}
	if (flag === '--tokens-file') {
		const found = findTokensFile(serverUrl)
		if (!found) process.exit(1) // absent == the MCP leg needs re-auth
		console.log(found.path)
		process.exit(0)
	}
	console.error(`unknown flag: ${flag}`)
	process.exit(2)
}
