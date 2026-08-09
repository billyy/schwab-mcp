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
 * safe to invoke unconditionally. Note that "still works" is about the GRANT,
 * not the access token — the latter expires hourly and mcp-remote replaces it
 * on its own. Escalating a routine expiry to a re-authorization costs a Schwab
 * login and an MFA text to the owner's phone, so the whole point of the probe
 * below is to escalate as rarely as possible without ever missing a real death.
 *
 * Usage:  npm run mcp-auth        (HEADED=1 to watch it)
 *         MCP_AUTH_NO_BROWSER=1   answer "would this need a re-auth?" without
 *                                 spending the MFA text on finding out
 *         npm run probe-check     assert the probe verdicts against the live
 *                                 worker, without touching the re-auth path
 */
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
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
/** Refuse to drive the Schwab consent screen — see the guard in main(). */
const NO_BROWSER = process.env.MCP_AUTH_NO_BROWSER === '1'
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

/**
 * Verdict of probing `/mcp` with the token mcp-remote has on disk.
 *
 *   'absent'       — no token file, or it holds no access_token
 *   'valid'        — the worker's OAuth provider accepted the bearer token
 *   'aged-out'     — 401, but the stored ACCESS token was already past its TTL,
 *                    so the 401 says nothing about the grant
 *   'rejected'     — 401 on an access token that should still have been good:
 *                    the grant itself is suspect (revoked, KV wiped)
 *
 * The access/grant split matters more than it looks. The provider mints access
 * tokens with a ONE HOUR ttl (DEFAULT_ACCESS_TOKEN_TTL) while the grant behind
 * them lives indefinitely and self-heals through a rotating refresh token. So
 * for all but the first hour after a re-auth, a 401 here is the *expected*
 * steady state of a perfectly healthy leg — treating it as "the grant is dead"
 * is what turns a routine run into a Schwab login and an MFA text to the
 * owner's phone. Neither verdict re-authorizes on its own: both hand off to
 * mcp-remote-client, which refreshes silently when it can (see main()).
 *
 * Anything we cannot classify throws instead of returning a verdict: a wrong
 * verdict either burns an MFA text needlessly or reports a broken leg as
 * healthy, and the latter is what once sent an operator chasing the wrong token.
 */
type TokenProbe = 'absent' | 'valid' | 'aged-out' | 'rejected'

/**
 * Only the worker's own /mcp handler (src/streamableHttp.ts) emits JSON-RPC
 * envelopes; the OAuth provider's errors and ngrok's tunnel pages do not.
 */
function asJsonRpc(
  body: string,
): { error?: { code?: number; message?: string } } | null {
  try {
    const parsed = JSON.parse(body) as {
      jsonrpc?: string
      error?: { code?: number; message?: string }
    }
    return parsed && parsed.jsonrpc === '2.0' ? parsed : null
  } catch {
    return null
  }
}

export async function probeStoredToken(serverUrl: string): Promise<TokenProbe> {
  const tokens = findTokensFile(serverUrl)
  if (!tokens) return 'absent'
  let stored: { access_token?: string; expires_in?: number }
  try {
    stored = JSON.parse(readFileSync(tokens.path, 'utf8'))
  } catch {
    return 'absent'
  }
  if (!stored.access_token) return 'absent'

  // mcp-remote writes this file at the moment it receives the tokens, so its
  // mtime is the issue time. `expires_in` is seconds (3600 from this worker).
  const ttlMs = (stored.expires_in ?? 0) * 1000
  const ageMs = Date.now() - tokens.mtimeMs
  const agedOut = ttlMs > 0 && ageMs >= ttlMs
  const mins = Math.round(ageMs / 60_000)

  const verdict = await classifyProbe(serverUrl, stored.access_token)
  if (verdict === 'valid') return 'valid'

  if (agedOut) {
    log(
      `stored access token is ${mins}min old with a ${Math.round(ttlMs / 60_000)}min TTL — ` +
        `the 401 is its normal expiry, NOT evidence about the grant`,
    )
    return 'aged-out'
  }
  log(`stored access token is only ${mins}min old but was refused — grant is suspect`)
  return 'rejected'
}

/**
 * Exported so the verdict logic can be exercised against the live worker
 * without going anywhere near the re-authorization path (which costs a real
 * MFA text). See `probe-check.ts`.
 */
export async function classifyProbe(
  serverUrl: string,
  accessToken: string,
): Promise<'valid' | 'rejected'> {
  // How the worker answers this probe (@cloudflare/workers-oauth-provider
  // handleApiRequest -> src/streamableHttp.ts mcpHttpHandler):
  //
  //   dead token   -> 401 {"error":"invalid_token"}. The provider validates the
  //                   bearer BEFORE routing, so a missing/expired/revoked token
  //                   or a wiped grant never reaches the MCP handler at all.
  //   live token   -> the handler runs, and answers this particular probe with
  //                   400 {"jsonrpc":"2.0","error":{"code":-32000,"message":
  //                   "Missing Mcp-Session-Id header"}} — a `ping` without an
  //                   initialize handshake is rejected at the PROTOCOL layer,
  //                   which is itself proof that auth passed.
  //   anything else-> not ours to interpret: ngrok's offline page, a 404 from a
  //                   mistyped MCP_URL, a proxy 5xx. None is an auth verdict.
  //
  // So the tell is not the status code but whether a JSON-RPC envelope came
  // back: only the post-auth handler produces one. We deliberately do NOT
  // exercise the refresh-token grant here — it rotates the refresh token, and
  // mcp-remote would never learn the new value, breaking the very session we
  // are trying to protect.
  let res: Response
  let body: string
  try {
    res = await fetch(serverUrl, {
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
    body = await res.text()
  } catch (err) {
    // Network/tunnel problem — not an auth verdict. Don't burn an MFA text on it.
    throw new Error(`Could not reach ${serverUrl}: ${(err as Error).message}`)
  }

  if (res.status === 401) {
    log('probe with stored token: HTTP 401 — the worker rejected the bearer token')
    return 'rejected'
  }

  const rpc = asJsonRpc(body)
  if (rpc) {
    const detail = rpc.error
      ? `JSON-RPC error ${rpc.error.code} "${rpc.error.message}" — answered by ` +
        `the MCP protocol layer, which only runs after the bearer token passed`
      : 'JSON-RPC result — the bearer token passed'
    log(`probe with stored token: HTTP ${res.status}, ${detail}`)
    return 'valid'
  }

  // Reached the tunnel but not the MCP handler: the stack below the grant is
  // broken. Re-authorizing would cost an MFA text and fix nothing, and calling
  // it healthy would hide the real fault — so fail loudly instead.
  throw new Error(
    `Inconclusive probe of ${serverUrl}: HTTP ${res.status} with a non-JSON-RPC ` +
      `body, so the request never reached the MCP handler. Check that wrangler ` +
      `dev and the ngrok tunnel are up and that MCP_URL is correct. Body: ` +
      body.slice(0, 300),
  )
}

async function main() {
  log(`mcp=${MCP_URL} headed=${HEADED} hash=${serverUrlHash(MCP_URL)}`)

  const probe = await probeStoredToken(MCP_URL)
  if (probe === 'valid') {
    log('stored MCP token still accepted by the worker — nothing to do')
    return
  }
  // Every remaining verdict goes to the same place, and that is deliberate:
  // mcp-remote-client tries its stored refresh token FIRST and only opens a
  // browser if that fails. So handing off costs nothing when the grant is
  // healthy, and escalates to a real login only when it genuinely has to.
  log(
    {
      absent: 'no stored MCP token on disk — handing off to mcp-remote-client',
      'aged-out':
        'access token aged out — handing off to mcp-remote-client, which should ' +
        'refresh it silently (no browser, no MFA) if the grant is intact',
      rejected:
        'access token refused before its TTL — handing off to mcp-remote-client; ' +
        'this one may need a real re-authorization',
    }[probe],
  )

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

  /**
   * mcp-remote 0.1.38's own success banner, printed once the transport is up.
   * Its appearance without an authorize URL is proof no browser was needed.
   */
  const connectedSilently = () =>
    /Connected successfully|Connected to remote server using/i.test(stderr + stdout)

  // mcp-remote prints "Please authorize this client by visiting:\n<url>" before
  // it tries to open a browser.
  const authorizeUrl = await new Promise<string | null>((resolve) => {
    const deadline = Date.now() + 120_000
    const tick = setInterval(() => {
      const match = (stderr + stdout).match(/^(https?:\/\/\S+\/authorize\?\S+)$/m)
      if (match) { clearInterval(tick); resolve(match[1]); return }
      // Either silent-success marker means no authorize URL is ever coming, so
      // stop waiting on one instead of sitting out the full deadline.
      if (connectedSilently() || (findTokensFile(MCP_URL)?.mtimeMs ?? 0) > tokensBefore) {
        clearInterval(tick); resolve(null); return
      }
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
    // No authorize URL means the client never needed a browser — it either
    // exchanged its refresh token or the token it had was fine. That is the
    // normal outcome whenever only the 1h access token had expired, and
    // reporting it as a failure both hides a healthy leg and walks the phase-2
    // fail counter toward MCP_AUTH_MAX_FAILURES, which would block a real
    // recovery later.
    //
    // Two independent success markers, because neither alone is sufficient:
    // a refresh rewrites the token file, but a client that connects on a token
    // that was still good leaves the file untouched (verified against
    // mcp-remote 0.1.38).
    const refreshed = findTokensFile(MCP_URL)
    const wroteToken = !!refreshed && refreshed.mtimeMs > tokensBefore
    if (wroteToken || connectedSilently()) {
      child.kill()
      log(
        wroteToken
          ? 'mcp-remote-client refreshed the token silently — no browser, no MFA text'
          : 'mcp-remote-client connected on the token it already had — no browser needed',
      )
      if (refreshed) log(`token file: ${refreshed.path}`)
      return
    }
    child.kill()
    throw new Error(`mcp-remote-client never printed an authorize URL (exit=${childCode}). stderr:\n${stderr}`)
  }

  // From here on a real Schwab login happens, which sends an MFA text to the
  // account owner's phone. NO_BROWSER lets an operator (or a test) find out
  // whether a run would escalate that far without actually spending it.
  if (NO_BROWSER) {
    child.kill()
    throw new Error(
      'interactive re-authorization required, but MCP_AUTH_NO_BROWSER=1 is set — ' +
        'refusing to drive the Schwab login (it would send an MFA text). ' +
        `Authorize URL was: ${authorizeUrl}`,
    )
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

// Only run when invoked as a script (`npm run mcp-auth`). Importing this module
// — as probe-check.ts does to test the verdict logic — must never kick off a
// re-authorization, which drives a real Schwab login and an MFA text.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[mcp-auth] FAILED:', err.message)
    process.exit(1)
  })
}
