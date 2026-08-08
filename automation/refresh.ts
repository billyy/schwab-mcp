/**
 * Refresh the Schwab -> worker OAuth token.
 *
 * Drives the worker's /authorize flow in a browser so Schwab redirects to
 * /callback and the WORKER writes a fresh `token:<schwabUserId>` into KV.
 * Schwab refresh tokens hard-expire after 7 days with no silent renewal, so
 * this runs twice weekly from launchd (see com.schwab-mcp.refresh.plist).
 *
 * The MCP authorization code that lands on localhost:8765/done is deliberately
 * NOT exchanged — this flow only cares about the server-side KV write. The
 * separate Desktop(mcp-remote) -> worker leg is handled by mcp-auth.ts.
 *
 * The browser login/MFA machinery lives in schwabLogin.ts, shared with
 * mcp-auth.ts.
 */
import { createServer, type Server } from 'node:http'
import {
  driveAuthorizeFlow,
  dumpTrustCookies,
  launchProfileContext,
} from './schwabLogin'

const WORKER_URL = process.env.WORKER_URL ?? 'https://obsolescent-corporately-easter.ngrok-free.dev'
const HEADED = process.env.HEADED === '1'
const REDIRECT_URI = 'http://localhost:8765/done'

const log = (message: string) => console.log(`[refresh] ${message}`)

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function registerClient(): Promise<string> {
  const res = await fetch(`${WORKER_URL}/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ngrok-skip-browser-warning': '1',
    },
    body: JSON.stringify({
      client_name: 'schwab-mcp-refresh',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    }),
  })
  if (!res.ok) throw new Error(`DCR failed: ${res.status} ${await res.text()}`)
  const json = await res.json() as { client_id: string }
  return json.client_id
}

async function main() {
  log(`worker=${WORKER_URL} headed=${HEADED}`)

  // Serve the redirect target ourselves: the final hop lands on
  // localhost:8765/done, and an actual listener gives us a definitive
  // completion signal (and a friendly page instead of a browser error).
  let callbackSeen = false
  const doneServer: Server = createServer((req, res) => {
    if (req.url?.startsWith('/done')) {
      callbackSeen = true
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h2>Schwab token refresh complete.</h2>This window can be closed.')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    doneServer.once('error', reject)
    doneServer.listen(8765, '127.0.0.1', resolve)
  }).catch((err) => {
    // Non-fatal: fall back to URL polling if the port is taken
    log(`could not listen on 8765 (continuing): ${(err as Error).message}`)
  })

  const clientId = await registerClient()
  const { verifier, challenge } = await pkce()
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))

  const authorizeUrl = new URL(`${WORKER_URL}/authorize`)
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('scope', 'openid profile')
  void verifier // not exchanged — we only care that /callback fires and writes KV

  const { ctx, page, snap, close } = await launchProfileContext({ headed: HEADED, log })

  try {
    await driveAuthorizeFlow(page, {
      authorizeUrl: authorizeUrl.toString(),
      isDone: () => callbackSeen || page.url().startsWith(REDIRECT_URI),
      headed: HEADED,
      snap,
      log,
    })
    log('callback completed — Schwab token written to KV')
  } finally {
    await dumpTrustCookies(ctx, log)
    await close()
    doneServer.close()
  }
}

main().catch((err) => {
  console.error('[refresh] FAILED:', err.message)
  process.exit(1)
})
