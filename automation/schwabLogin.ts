/**
 * Shared Schwab browser-login driver.
 *
 * Extracted verbatim from refresh.ts so both OAuth flows can use it:
 *   - refresh.ts  — refreshes the Schwab -> worker token (writes KV server-side)
 *   - mcp-auth.ts — re-authorizes the Desktop(mcp-remote) -> worker MCP leg
 *
 * Both land on the same Schwab consent pages and both need the same MFA
 * handling; only the completion condition differs, which is why the state loop
 * takes an injected `isDone()` predicate.
 *
 * This logic is hardened against Schwab's Angular SPA (programmatic fill() is
 * ignored, hidden buttons linger in the DOM, URL-based MFA detection because
 * the terms legalese false-positives on text matching). Change it only with a
 * headed run to verify.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'

export const PROFILE_DIR = join(homedir(), '.schwab-mcp-auth', 'profile')
export const DEBUG_DIR = join(homedir(), '.schwab-mcp-auth', 'debug')

chromium.use(stealth())

export function keychain(account: string): string {
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
function latestSchwabCode(sinceMs: number, log: Log): string | null {
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
    log(`Messages DB read failed this poll (will retry): ${stderr.trim() || err?.message}`)
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
export async function waitForSchwabCode(
  sinceMs: number,
  log: Log,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const code = latestSchwabCode(sinceMs, log)
    if (code) return code
    if (Date.now() > deadline) {
      throw new Error(`No Schwab MFA text arrived within ${timeoutMs / 1000}s`)
    }
    await new Promise((r) => setTimeout(r, 3_000))
  }
}

/**
 * ngrok's free tier sometimes shows a "You are about to visit ..." interstitial
 * on navigations to the tunnel URL (the extraHTTPHeaders skip-header usually
 * suppresses it, but not always). Click through it when it appears.
 */
export async function skipNgrokInterstitial(
  page: import('playwright').Page,
  log: Log,
): Promise<boolean> {
  const visit = page.locator(
    'button:has-text("Visit Site"), a:has-text("Visit Site")',
  )
  if (await visit.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
    log('ngrok interstitial detected — clicking through')
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      visit.first().click(),
    ])
    return true
  }
  return false
}

export type Log = (message: string) => void

export interface ProfileSession {
  ctx: import('playwright').BrowserContext
  page: import('playwright').Page
  snap: (label: string) => Promise<void>
  close: () => Promise<void>
}

/**
 * Launch the persistent Chromium profile shared by both flows. The profile
 * carries Schwab's device-trust cookies, so callers MUST serialize access to it
 * (see the shlock in run-refresh.sh) — Playwright fails on a profile dir that
 * is already in use.
 */
export async function launchProfileContext(
  { headed, log }: { headed: boolean; log: Log },
): Promise<ProfileSession> {
  mkdirSync(PROFILE_DIR, { recursive: true })
  mkdirSync(DEBUG_DIR, { recursive: true })

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'ngrok-skip-browser-warning': '1' },
  })
  const page = await ctx.newPage()

  const fsp = await import('node:fs/promises')
  const snap = async (label: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const png = join(DEBUG_DIR, `${stamp}-${label}.png`)
    const html = join(DEBUG_DIR, `${stamp}-${label}.html`)
    await page.screenshot({ path: png, fullPage: true }).catch(() => {})
    await fsp.writeFile(html, await page.content()).catch(() => {})
    log(`snapshot ${label}: url=${page.url()}\n  ${png}\n  ${html}`)
  }

  return { ctx, page, snap, close: () => ctx.close() }
}

/** Dump the profile's Schwab cookies for device-trust diagnostics. */
export async function dumpTrustCookies(
  ctx: import('playwright').BrowserContext,
  log: Log,
): Promise<void> {
  try {
    const fsp = await import('node:fs/promises')
    const cookies = await ctx.cookies()
    const interesting = cookies.filter((c) =>
      /schwab/i.test(c.domain) &&
      (/trust|device|remember|persistent|mfa/i.test(c.name) ||
       (c.expires > 0 && c.expires - Date.now() / 1000 > 7 * 24 * 3600))
    )
    const cookieFile = join(DEBUG_DIR, `cookies-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await fsp.writeFile(cookieFile, JSON.stringify(cookies, null, 2))
    log(`${cookies.length} total cookies, ${interesting.length} interesting (trust/device/long-lived)`)
    log(`full dump: ${cookieFile}`)
    for (const c of interesting) {
      const ttlDays = c.expires > 0 ? Math.round((c.expires - Date.now() / 1000) / 86400) : -1
      console.log(`  ${c.domain}  ${c.name}  ttl=${ttlDays}d`)
    }
  } catch (err) {
    log(`cookie dump failed: ${(err as Error).message}`)
  }
}

export interface AuthorizeFlowOptions {
  /** Full /authorize URL to open. */
  authorizeUrl: string
  /**
   * Completion predicate, polled once per loop iteration. refresh.ts watches
   * its own localhost:8765 listener; mcp-auth.ts watches mcp-remote's callback.
   */
  isDone: () => boolean
  headed: boolean
  snap: (label: string) => Promise<void>
  log: Log
  /** Overall budget for the post-login state machine. */
  timeoutMs?: number
}

/**
 * Open /authorize, click through the worker's consent screen, log into Schwab
 * (auto-completing SMS MFA), and click through the gateway's consent pages
 * until `isDone()` reports the flow reached its redirect target.
 */
export async function driveAuthorizeFlow(
  page: import('playwright').Page,
  opts: AuthorizeFlowOptions,
): Promise<void> {
  const { authorizeUrl, isDone, headed, snap, log } = opts
  const username = keychain('username')
  const password = keychain('password')

  await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded' })
  await skipNgrokInterstitial(page, log)
  log(`after /authorize: url=${page.url()} title="${await page.title()}"`)

  const approve = page.locator(
    'button:has-text("Approve"), button:has-text("Allow"), button:has-text("Authorize"), ' +
    'input[type=submit][value*="Approve" i], input[type=submit][value*="Allow" i], ' +
    'input[type=submit][value*="Authorize" i]'
  )
  if (await approve.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
    log('clicking consent button')
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      approve.first().click(),
    ])
  } else {
    log('no consent button found — flow may already be past it')
  }

  // Already done? (e.g. the worker had a live Schwab session and redirected
  // straight through without ever hitting schwab.com)
  if (isDone()) return

  try {
    await page.waitForURL(/schwabapi\.com|schwab\.com/i, { timeout: 30_000 })
  } catch {
    if (isDone()) return
    await snap('no-schwab-nav')
    throw new Error(`Did not navigate to Schwab. Stuck at: ${page.url()} — see snapshot`)
  }

  // Login is handled inside the state loop below (the form can appear more
  // than once, e.g. #/login-one-step after MFA).

  // Post-login the gateway SPA can land on any of: the MFA page, the
  // terms/consent page, an ngrok interstitial (any hop through the tunnel,
  // including the Schwab → /callback redirect), or straight through to the
  // callback. Poll and react to whichever state actually appears.
  const loginInput = page.locator('#loginIdInput, input[name="LoginId"]')
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000)
  let lastActionClick = 0
  let mfaRequestedAt = 0
  for (;;) {
    if (isDone()) break

    if (await skipNgrokInterstitial(page, log)) continue

    // Schwab sometimes bounces back to a fresh login form mid-flow
    // (e.g. #/login-one-step after MFA) — fill it whenever it appears.
    // Type keystroke-by-keystroke: the Angular form ignores programmatic
    // fill() and leaves the Log in button disabled.
    if (await loginInput.first().isVisible({ timeout: 500 }).catch(() => false)) {
      log('login form shown — typing credentials')
      const pwdInput = page.locator('#passwordInput, input[name="Password"]')
      await loginInput.first().fill('')
      await loginInput.first().pressSequentially(username, { delay: 30 })
      await pwdInput.first().fill('')
      await pwdInput.first().pressSequentially(password, { delay: 30 })
      const loginBtn = page.locator('#btnLogin, button[type=submit]')
      try {
        await loginBtn.first().click({ timeout: 10_000 })
      } catch {
        log('login button not clickable — pressing Enter instead')
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
        log('MFA: selecting "Text me"')
        mfaRequestedAt = Date.now()
        await textMeTile.first().click().catch((err) => {
          log(`MFA: Text me click failed: ${(err as Error).message}`)
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
        log('MFA: waiting for code via iMessage...')
        const code = await waitForSchwabCode(mfaRequestedAt - 10_000, log)
        log('MFA: code received, typing it in')
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
        if (headed) {
          log('MFA: unrecognized screen — complete it manually; waiting...')
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
        log('checking acceptTerms')
        try {
          await terms.first().check({ force: true })
        } catch (err) {
          log(`direct check failed, trying label click: ${(err as Error).message}`)
          await page.locator('label[for="acceptTerms"]').click({ force: true }).catch(() => {})
        }
        const checked = await terms.first().isChecked().catch(() => false)
        if (!checked) {
          log('still unchecked, dispatching via JS')
          await terms.first().evaluate((el: HTMLInputElement) => {
            el.checked = true
            el.dispatchEvent(new Event('change', { bubbles: true }))
            el.dispatchEvent(new Event('input', { bubbles: true }))
          })
        }
      }
      log(`clicking action button on ${page.url()}`)
      await visibleBtn.click({ timeout: 10_000 }).catch((err) => {
        log(`action click failed (may be navigating): ${(err as Error).message}`)
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
}
