/**
 * Re-authorize the Desktop(mcp-remote) -> worker MCP leg, unattended.
 *
 * This is the SECOND of the two independent OAuth legs (refresh.ts handles the
 * Schwab -> worker one). Normally it never needs to run: the worker issues a
 * rotating refresh token and mcp-remote exchanges it automatically on any 401.
 * It exists for the cases where the grant is genuinely gone — revoked, KV
 * wiped, the tunnel URL changed (which changes mcp-remote's state-file hash),
 * or a first-time setup.
 *
 * Rather than hand-rolling a /token exchange and writing mcp-remote's token
 * file ourselves (whose schema is its private business and would drift), we run
 * mcp-remote's own `mcp-remote-client` binary — which authorizes, lists tools,
 * and exits — and drive the Schwab consent screen it opens with the shared
 * Playwright driver in schwabLogin.ts.
 *
 * Idempotent: exits 0 immediately when the existing token still works, so it is
 * safe to invoke unconditionally.
 *
 * Usage:  npm run mcp-auth        (HEADED=1 to watch it)
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findStateFile, findTokensFile, serverUrlHash } from './mcpRemotePaths.mjs'
import {
  driveAuthorizeFlow,
  dumpTrustCookies,
  launchProfileContext,
} from './schwabLogin'

const WORKER_URL = process.env.WORKER_URL ?? 'https://obsolescent-corporately-easter.ngrok-free.dev'
/**
 * MUST match the URL in Claude Desktop's config byte for byte — mcp-remote keys
 * its stored tokens by md5 of this exact string, so any difference silently
 * authorizes a *different* slot and leaves Desktop still broken.
 */
const MCP_URL = process.env.MCP_URL ?? `${WORKER_URL}/mcp`
const MCP_REMOTE_VERSION = process.env.MCP_REMOTE_VERSION ?? '0.1.38'
const HEADED = process.env.HEADED === '1'
const HERE = dirname(fileURLToPath(import.meta.url))

const log = (message: string) => console.log(`[mcp-auth] ${message}`)

/** mcp-remote's own default: 3335 + (first 4 hex digits of the hash) % 45816 */
function defaultCallbackPort(serverUrl: string): number {
  return 3335 + (parseInt(serverUrlHash(serverUrl).slice(0, 4), 16) % 45816)
}

/**
 * Where mcp-remote will land after consent. Prefer the registered redirect_uri
 * so we match whatever port the existing client registration actually uses.
 */
function callbackPrefix(serverUrl: string): string {
  const info = findStateFile(serverUrl, 'client_info.json')
  if (info) {
    try {
      const parsed = JSON.parse(readFileSync(info.path, 'utf8')) as {
        redirect_uris?: string[]
      }
      const uri = parsed.redirect_uris?.[0]
      if (uri) return uri
    } catch {
      // fall through to the computed default
    }
  }
  return `http://localhost:${defaultCallbackPort(serverUrl)}/oauth/callback`
}

/** True when the stored access token is still accepted by the worker. */
async function tokenStillWorks(serverUrl: string): Promise<boolean> {
  const tokens = findTokensFile(serverUrl)
  if (!tokens) return false
  let accessToken: string | undefined
  try {
    accessToken = (JSON.parse(readFileSync(tokens.path, 'utf8')) as {
      access_token?: string
    }).access_token
  } catch {
    return false
  }
  if (!accessToken) return false

  // A bare POST with no body is rejected by the MCP handler, but only AFTER the
  // bearer token is validated — so 401 means auth is dead and anything else
  // means it is alive. We deliberately do NOT exercise the refresh-token grant
  // here: it rotates the refresh token, and mcp-remote would never learn the
  // new value, breaking the very session we are trying to protect.
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'ngrok-skip-browser-warning': '1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(20_000),
    })
    log(`probe with stored token: HTTP ${res.status}`)
    return res.status !== 401
  } catch (err) {
    // Network/tunnel problem — not an auth verdict. Don't burn an MFA text on it.
    throw new Error(`Could not reach ${serverUrl}: ${(err as Error).message}`)
  }
}

async function main() {
  log(`mcp=${MCP_URL} headed=${HEADED} hash=${serverUrlHash(MCP_URL)}`)

  if (await tokenStillWorks(MCP_URL)) {
    log('stored MCP token still valid — nothing to do')
    return
  }
  log('stored MCP token missing or rejected — running full re-authorization')

  const tokensBefore = findTokensFile(MCP_URL)?.mtimeMs ?? 0
  const doneUrl = callbackPrefix(MCP_URL)
  log(`expecting mcp-remote callback at ${doneUrl}`)

  // `--auth-timeout 600`: the default is 30s, which a Schwab login plus an SMS
  // MFA round-trip blows straight through. Without this the child gives up and
  // tears down its callback listener mid-flow.
  const child = spawn(
    'npx',
    [
      '-y', '-p', `mcp-remote@${MCP_REMOTE_VERSION}`, 'mcp-remote-client',
      MCP_URL,
      '--transport', 'http-only',
      '--auth-timeout', '600',
    ],
    {
      cwd: HERE,
      env: {
        ...process.env,
        // Suppress mcp-remote's own browser launch; we drive the page ourselves.
        PATH: `${join(HERE, 'bin')}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let childExited = false
  let childCode: number | null = null
  let stderr = ''
  let stdout = ''
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      childExited = true
      childCode = code
      resolve()
    })
  })
  child.stdout.on('data', (d) => { stdout += d.toString() })
  child.stderr.on('data', (d) => {
    const chunk = d.toString()
    stderr += chunk
    for (const line of chunk.split('\n')) {
      if (line.trim()) log(`  client| ${line.trim()}`)
    }
  })

  // mcp-remote prints "Please authorize this client by visiting:\n<url>" before
  // it tries to open a browser.
  const authorizeUrl = await new Promise<string | null>((resolve) => {
    const deadline = Date.now() + 120_000
    const tick = setInterval(() => {
      const match = (stderr + stdout).match(/^(https?:\/\/\S+\/authorize\?\S+)$/m)
      if (match) { clearInterval(tick); resolve(match[1]); return }
      if (childExited || Date.now() > deadline) { clearInterval(tick); resolve(null) }
    }, 500)
  })

  if (!authorizeUrl) {
    if (/completed by another instance|Authentication completed/i.test(stderr)) {
      // The live Desktop proxy holds the auth lock; our client is waiting on it
      // rather than driving its own flow. Not a failure — just not our turn.
      child.kill()
      log('another mcp-remote instance owns the auth flow — skipping (quit Claude Desktop to force)')
      return
    }
    child.kill()
    throw new Error(`mcp-remote-client never printed an authorize URL (exit=${childCode}). stderr:\n${stderr}`)
  }
  log(`driving authorize URL: ${authorizeUrl}`)

  const { ctx, page, snap, close } = await launchProfileContext({ headed: HEADED, log })
  try {
    await driveAuthorizeFlow(page, {
      authorizeUrl,
      isDone: () => childExited || page.url().startsWith(doneUrl),
      headed: HEADED,
      snap,
      log,
    })
    log('consent flow finished — waiting for mcp-remote-client to write its token')
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 60_000)),
    ])
  } finally {
    await dumpTrustCookies(ctx, log)
    await close()
    if (!childExited) child.kill()
  }

  const tokensAfter = findTokensFile(MCP_URL)
  if (!tokensAfter || tokensAfter.mtimeMs <= tokensBefore) {
    throw new Error(
      `no new token written (exit=${childCode}). mcp-remote-client stderr:\n${stderr}`,
    )
  }
  if (childCode !== 0 && childCode !== null) {
    log(`WARNING: client exited ${childCode} but a fresh token was written — continuing`)
  }
  log(`re-authorization complete: ${tokensAfter.path}`)
  log('Claude Desktop must be restarted to pick up the new token.')
}

main().catch((err) => {
  console.error('[mcp-auth] FAILED:', err.message)
  process.exit(1)
})
