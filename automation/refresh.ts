import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'

const WORKER_URL = process.env.WORKER_URL ?? 'https://obsolescent-corporately-easter.ngrok-free.dev'
const HEADED = process.env.HEADED === '1'
const PROFILE_DIR = join(homedir(), '.schwab-mcp-auth', 'profile')
const REDIRECT_URI = 'http://localhost:8765/done'

chromium.use(stealth())

function keychain(account: string): string {
  return execFileSync('security', [
    'find-generic-password', '-s', 'schwab-mcp', '-a', account, '-w',
  ]).toString().trim()
}

/** Schwab's SMS short code sender */
const SCHWAB_SMS_SENDER = '87047'
const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')

/**
 * Read the newest Schwab MFA text (from short code 87047) received after
 * `sinceMs` out of the local Messages database and extract the numeric code.
 * Requires Full Disk Access for the invoking process. Returns null if no
 * matching message exists yet.
 */
function latestSchwabCode(sinceMs: number): string | null {
  // Messages stores dates as nanoseconds since 2001-01-01 (Apple epoch)
  const appleNs = Math.floor((sinceMs / 1000 - 978307200) * 1e9)
  const sql =
    `SELECT m.text FROM message m ` +
    `LEFT JOIN handle h ON m.handle_id = h.ROWID ` +
    `WHERE h.id = '${SCHWAB_SMS_SENDER}' AND m.date > ${appleNs} AND m.text IS NOT NULL ` +
    `ORDER BY m.date DESC LIMIT 1;`
  let text: string
  try {
    text = execFileSync('/usr/bin/sqlite3', ['-readonly', CHAT_DB, sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim()
  } catch (err: any) {
    const stderr: string = err?.stderr?.toString() ?? ''
    if (/authorization denied|not authorized/i.test(stderr)) {
      throw new Error(
        `Cannot read Messages database — Full Disk Access missing for this process tree: ${stderr.trim()}`,
      )
    }
    // Transient (e.g. database locked while Messages.app writes the incoming
    // SMS) — treat as "no message yet" and let the poll loop retry.
    console.log(
      '[refresh] Messages DB read failed this poll (will retry):',
      stderr.trim() || err?.message,
    )
    return null
  }
  if (!text) return null
  // Prefer digits adjacent to the word "code"; fall back to the last digit run
  const nearCode = text.match(/code[^0-9]{0,40}(\d{5,8})/i)
  if (nearCode) return nearCode[1]
  const all = text.match(/\b\d{5,8}\b/g)
  return all ? all[all.length - 1] : null
}

/** Poll the Messages DB until a Schwab code newer than `sinceMs` appears */
async function waitForSchwabCode(sinceMs: number, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const code = latestSchwabCode(sinceMs)
    if (code) return code
    if (Date.now() > deadline) {
      throw new Error(`No Schwab MFA text arrived within ${timeoutMs / 1000}s`)
    }
    await new Promise((r) => setTimeout(r, 3_000))
  }
}

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

/**
 * ngrok's free tier sometimes shows a "You are about to visit ..." interstitial
 * on navigations to the tunnel URL (the extraHTTPHeaders skip-header usually
 * suppresses it, but not always). Click through it when it appears.
 */
async function skipNgrokInterstitial(page: import('playwright').Page): Promise<boolean> {
  const visit = page.locator(
    'button:has-text("Visit Site"), a:has-text("Visit Site")',
  )
  if (await visit.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
    console.log('[refresh] ngrok interstitial detected — clicking through')
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      visit.first().click(),
    ])
    return true
  }
  return false
}

async function main() {
  console.log(`[refresh] worker=${WORKER_URL} headed=${HEADED}`)
  mkdirSync(PROFILE_DIR, { recursive: true })

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
    console.log('[refresh] could not listen on 8765 (continuing):', (err as Error).message)
  })

  const username = keychain('username')
  const password = keychain('password')
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

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADED,
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'ngrok-skip-browser-warning': '1' },
  })
  const page = await ctx.newPage()

  const debugDir = join(homedir(), '.schwab-mcp-auth', 'debug')
  mkdirSync(debugDir, { recursive: true })
  const fsp = await import('node:fs/promises')
  const snap = async (label: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const png = join(debugDir, `${stamp}-${label}.png`)
    const html = join(debugDir, `${stamp}-${label}.html`)
    await page.screenshot({ path: png, fullPage: true }).catch(() => {})
    await fsp.writeFile(html, await page.content()).catch(() => {})
    console.log(`[refresh] snapshot ${label}: url=${page.url()}\n  ${png}\n  ${html}`)
  }

  try {
    await page.goto(authorizeUrl.toString(), { waitUntil: 'domcontentloaded' })
    await skipNgrokInterstitial(page)
    console.log(`[refresh] after /authorize: url=${page.url()} title="${await page.title()}"`)

    const approve = page.locator(
      'button:has-text("Approve"), button:has-text("Allow"), button:has-text("Authorize"), ' +
      'input[type=submit][value*="Approve" i], input[type=submit][value*="Allow" i], ' +
      'input[type=submit][value*="Authorize" i]'
    )
    if (await approve.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      console.log('[refresh] clicking consent button')
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        approve.first().click(),
      ])
    } else {
      console.log('[refresh] no consent button found — flow may already be past it')
    }

    try {
      await page.waitForURL(/schwabapi\.com|schwab\.com/i, { timeout: 30_000 })
    } catch (err) {
      await snap('no-schwab-nav')
      throw new Error(`Did not navigate to Schwab. Stuck at: ${page.url()} — see snapshot`)
    }

    // Login is handled inside the state loop below (the form can appear more
    // than once, e.g. #/login-one-step after MFA).

    // Post-login the gateway SPA can land on any of: the MFA page, the
    // terms/consent page, an ngrok interstitial (any hop through the tunnel,
    // including the Schwab → /callback redirect), or straight through to the
    // localhost callback. Poll and react to whichever state actually appears.
    const loginInput = page.locator('#loginIdInput, input[name="LoginId"]')
    const deadline = Date.now() + 600_000
    let lastActionClick = 0
    let mfaRequestedAt = 0
    for (;;) {
      if (callbackSeen || page.url().startsWith(REDIRECT_URI)) break

      if (await skipNgrokInterstitial(page)) continue

      // Schwab sometimes bounces back to a fresh login form mid-flow
      // (e.g. #/login-one-step after MFA) — fill it whenever it appears.
      // Type keystroke-by-keystroke: the Angular form ignores programmatic
      // fill() and leaves the Log in button disabled.
      if (await loginInput.first().isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('[refresh] login form shown — typing credentials')
        const pwdInput = page.locator('#passwordInput, input[name="Password"]')
        await loginInput.first().fill('')
        await loginInput.first().pressSequentially(username, { delay: 30 })
        await pwdInput.first().fill('')
        await pwdInput.first().pressSequentially(password, { delay: 30 })
        const loginBtn = page.locator('#btnLogin, button[type=submit]')
        try {
          await loginBtn.first().click({ timeout: 10_000 })
        } catch {
          console.log('[refresh] login button not clickable — pressing Enter instead')
          await pwdInput.first().press('Enter').catch(() => {})
        }
        await page.waitForLoadState('domcontentloaded').catch(() => {})
        continue
      }

      // MFA (URL-based detection only: consent/terms legalese contains MFA-ish
      // phrases like "verify your identity", so text matching false-positives).
      // Auto-complete it: pick "Text me", read the code from the local
      // Messages DB (Schwab sends from short code 87047), type it in.
      if (/#\/(authenticators|otp)/i.test(page.url())) {
        const textMeTile = page.locator('text=/Text me/i')
        const codeInput = page.locator(
          '#securityCode, input[formcontrolname="otpAccessCodeCtrl"], ' +
            'input[autocomplete="one-time-code"], input[inputmode="numeric"], ' +
            'input[type=tel], input[name*="code" i], input[id*="code" i]',
        )

        if (mfaRequestedAt === 0 && (await textMeTile.first().isVisible({ timeout: 1_000 }).catch(() => false))) {
          console.log('[refresh] MFA: selecting "Text me"')
          mfaRequestedAt = Date.now()
          await textMeTile.first().click().catch((err) => {
            console.log('[refresh] MFA: Text me click failed:', (err as Error).message)
            mfaRequestedAt = 0
          })
          continue
        }

        let visibleCode: import('playwright').Locator | null = null
        for (const candidate of await codeInput.all().catch(() => [])) {
          if (await candidate.isVisible().catch(() => false)) {
            visibleCode = candidate
            break
          }
        }
        if (mfaRequestedAt > 0 && visibleCode) {
          console.log('[refresh] MFA: waiting for code via iMessage...')
          const code = await waitForSchwabCode(mfaRequestedAt - 10_000)
          console.log('[refresh] MFA: code received, typing it in')
          await visibleCode.fill('')
          await visibleCode.pressSequentially(code, { delay: 50 })
          // Tick any "remember/trust this device" checkbox while we're here
          const remember = page.locator(
            '#checkbox-remember-device, input[name="rememberDeviceCheck"], ' +
              'input[type=checkbox][name*="remember" i], input[type=checkbox][id*="remember" i], ' +
              'input[type=checkbox][name*="trust" i], input[type=checkbox][id*="trust" i]',
          )
          for (const box of await remember.all().catch(() => [])) {
            if (await box.isVisible().catch(() => false)) {
              await box.check({ force: true }).catch(() => {})
            }
          }
          mfaRequestedAt = 0
          // fall through: the generic action-button click below submits the code
        } else if (mfaRequestedAt === 0 && !visibleCode) {
          // Unrecognized MFA sub-screen. Headed: let the user drive it.
          if (HEADED) {
            console.log('[refresh] MFA: unrecognized screen — complete it manually; waiting...')
            await page
              .waitForURL((url) => !/#\/authenticators/i.test(url.href), { timeout: 300_000 })
              .catch(() => {})
            continue
          }
          await snap('mfa-unrecognized')
          throw new Error('MFA prompted but no "Text me" option or code input found — see snapshot')
        }
      }

      // Consent-style pages: terms ("Instruction and Informed Consent",
      // #submit-btn) and account selection ("Continue"). Check any terms box,
      // then click the page's primary action button. Re-click at most every
      // 10s so a swallowed click doesn't strand the flow.
      const actionBtn = page.locator(
        '#submit-btn, #continueButton, ' +
          'button:has-text("Continue"), button:has-text("Accept"), button:has-text("Confirm"), ' +
          'button:has-text("Verify"), button:has-text("Next"), button:has-text("Submit"), ' +
          'button:has-text("Log In"), button:has-text("Done"), ' +
          'input[type=submit][value*="Continue" i], input[type=submit][value*="Accept" i]',
      )
      // Pick the first *visible* candidate: the SPA leaves hidden buttons from
      // prior screens in the DOM, so .first() alone can land on an invisible one.
      let visibleBtn: import('playwright').Locator | null = null
      if (Date.now() - lastActionClick > 10_000) {
        for (const candidate of await actionBtn.all().catch(() => [])) {
          if (await candidate.isVisible().catch(() => false)) {
            visibleBtn = candidate
            break
          }
        }
      }
      if (visibleBtn) {
        const terms = page.locator('input[name="acceptTerms"], #acceptTerms')
        if (await terms.count() > 0) {
          console.log('[refresh] checking acceptTerms')
          try {
            await terms.first().check({ force: true })
          } catch (err) {
            console.log('[refresh] direct check failed, trying label click:', (err as Error).message)
            await page.locator('label[for="acceptTerms"]').click({ force: true }).catch(() => {})
          }
          const checked = await terms.first().isChecked().catch(() => false)
          if (!checked) {
            console.log('[refresh] still unchecked, dispatching via JS')
            await terms.first().evaluate((el: HTMLInputElement) => {
              el.checked = true
              el.dispatchEvent(new Event('change', { bubbles: true }))
              el.dispatchEvent(new Event('input', { bubbles: true }))
            })
          }
        }
        console.log(`[refresh] clicking action button on ${page.url()}`)
        await visibleBtn.click({ timeout: 10_000 }).catch((err) => {
          console.log('[refresh] action click failed (may be navigating):', (err as Error).message)
        })
        lastActionClick = Date.now()
        continue
      }

      if (Date.now() > deadline) {
        await snap('post-login-timeout')
        throw new Error(`Stuck after login at: ${page.url()} — see snapshot`)
      }
      await page.waitForTimeout(1_000)
    }
    console.log('[refresh] callback completed — Schwab token written to KV')
  } finally {
    try {
      const cookies = await ctx.cookies()
      const interesting = cookies.filter((c) =>
        /schwab/i.test(c.domain) &&
        (/trust|device|remember|persistent|mfa/i.test(c.name) ||
         (c.expires > 0 && c.expires - Date.now() / 1000 > 7 * 24 * 3600))
      )
      const cookieFile = join(debugDir, `cookies-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      await fsp.writeFile(cookieFile, JSON.stringify(cookies, null, 2))
      console.log(`[refresh] ${cookies.length} total cookies, ${interesting.length} interesting (trust/device/long-lived)`)
      console.log(`[refresh] full dump: ${cookieFile}`)
      for (const c of interesting) {
        const ttlDays = c.expires > 0 ? Math.round((c.expires - Date.now() / 1000) / 86400) : -1
        console.log(`  ${c.domain}  ${c.name}  ttl=${ttlDays}d`)
      }
    } catch (err) {
      console.log('[refresh] cookie dump failed:', (err as Error).message)
    }
    await ctx.close()
    doneServer.close()
  }
}

main().catch((err) => {
  console.error('[refresh] FAILED:', err.message)
  process.exit(1)
})
