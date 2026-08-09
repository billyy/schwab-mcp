/**
 * Verify mcp-auth.ts's probe verdicts against the LIVE worker without ever
 * touching the re-authorization path — so this costs no MFA text and can be
 * re-run freely whenever the MCP leg is touched.
 *
 * It imports the same functions mcp-auth.ts uses in production:
 *
 *   1. bogus bearer token on /mcp   -> 'rejected'  (the 401 path really fires)
 *   2. stored token on /mcp         -> 'valid' while the 1h access token is
 *                                      inside its TTL, 'rejected' once it is not
 *   3. stored token on a non-MCP URL-> throws 'Inconclusive' (no re-auth)
 *   4. probeStoredToken()           -> 'valid' when fresh, 'aged-out' when the
 *                                      access token has simply expired
 *
 * Check 1 is what keeps 'valid' from being a rubber stamp; check 4 is what
 * keeps a routine hourly expiry from being read as a dead grant and billed to
 * the account owner's phone as an MFA text.
 *
 * Run it in both states to cover everything: once with an expired access token,
 * then again right after a refresh.
 *
 * Usage:  npm run probe-check
 */
import { readFileSync, statSync } from 'node:fs'
import { classifyProbe, probeStoredToken } from './mcp-auth'
import { findTokensFile } from './mcpRemotePaths.mjs'

const WORKER_URL =
  process.env.WORKER_URL ?? 'https://obsolescent-corporately-easter.ngrok-free.dev'
const MCP_URL = process.env.MCP_URL ?? `${WORKER_URL}/mcp`

let failures = 0

function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
  if (!ok) failures++
}

async function main() {
  const tokens = findTokensFile(MCP_URL)
  if (!tokens) throw new Error(`no mcp-remote token file for ${MCP_URL}`)
  const stored = JSON.parse(readFileSync(tokens.path, 'utf8')) as {
    access_token?: string
    expires_in?: number
  }
  if (!stored.access_token) throw new Error(`no access_token in ${tokens.path}`)

  const ageMin = (Date.now() - statSync(tokens.path).mtimeMs) / 60_000
  const ttlMin = (stored.expires_in ?? 0) / 60
  const fresh = ageMin < ttlMin
  console.log(`token file: ${tokens.path}`)
  console.log(
    `access token age ${ageMin.toFixed(1)}min of ${ttlMin}min TTL -> ` +
      `${fresh ? 'INSIDE its TTL' : 'EXPIRED'}\n`,
  )

  // 1. A token the worker cannot possibly know must read as rejected. Same
  //    three-part `userId:grantId:secret` shape as a real one, so this exercises
  //    the KV lookup rather than the provider's format check.
  try {
    const verdict = await classifyProbe(
      MCP_URL,
      'probe-check-not-a-real:grant-id:secret',
    )
    check('bogus token on /mcp', verdict === 'rejected', `verdict=${verdict}`)
  } catch (err) {
    check('bogus token on /mcp', false, `threw: ${(err as Error).message}`)
  }

  // 2. The stored token: accepted while it is inside its TTL, refused after.
  const want = fresh ? 'valid' : 'rejected'
  try {
    const verdict = await classifyProbe(MCP_URL, stored.access_token)
    check(
      'stored token on /mcp',
      verdict === want,
      `verdict=${verdict} (expected ${want} for a${fresh ? ' fresh' : 'n expired'} token)`,
    )
  } catch (err) {
    check('stored token on /mcp', false, `threw: ${(err as Error).message}`)
  }

  // 3. A reachable host that is not the MCP handler must be inconclusive — not
  //    silently "valid" (the old bug) and not a re-auth trigger.
  try {
    const verdict = await classifyProbe(`${WORKER_URL}/not-mcp`, stored.access_token)
    check('non-MCP path', false, `expected a throw, got verdict=${verdict}`)
  } catch (err) {
    const msg = (err as Error).message
    check('non-MCP path', msg.startsWith('Inconclusive probe'), msg.slice(0, 120))
  }

  // 4. The verdict mcp-auth.ts actually acts on. An expired access token must
  //    come back 'aged-out', never 'rejected': 'rejected' is the one that reads
  //    as "the grant is gone".
  const wantProbe = fresh ? 'valid' : 'aged-out'
  const probe = await probeStoredToken(MCP_URL)
  check(
    'probeStoredToken verdict',
    probe === wantProbe,
    `verdict=${probe} (expected ${wantProbe})`,
  )

  console.log(failures === 0 ? '\nall probe checks passed' : `\n${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('probe-check FAILED:', err.message)
  process.exit(1)
})
