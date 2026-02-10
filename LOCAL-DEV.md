# Local Development with HTTPS

Schwab's OAuth flow requires HTTPS redirect URIs. This guide shows how to set up local development with HTTPS using Cloudflare Tunnel.

## Quick Start

### Automated Setup (Recommended)

```bash
./start-local-dev.sh
```

This script will:
1. Start a Cloudflare tunnel with HTTPS
2. Display your unique HTTPS URL
3. Show the callback URL to configure in Schwab Developer Portal
4. Provide step-by-step instructions

### Manual Setup

If you prefer manual control:

1. **Start Cloudflare Tunnel:**
   ```bash
   cloudflared tunnel --url http://localhost:8788
   ```

   Note the HTTPS URL (e.g., `https://random-words-123.trycloudflare.com`)

2. **Update `.dev.vars`:**
   ```bash
   ./update-redirect-uri.sh https://your-tunnel-url.trycloudflare.com
   ```

   Or manually edit `.dev.vars`:
   ```
   SCHWAB_REDIRECT_URI=https://your-tunnel-url.trycloudflare.com/callback
   ```

3. **Configure Schwab Developer Portal:**
   - Go to https://developer.schwab.com
   - Edit your app
   - Add redirect URI: `https://your-tunnel-url.trycloudflare.com/callback`
   - Save changes

4. **Start Dev Server:**
   ```bash
   npm run dev
   ```

5. **Launch MCP Inspector:**
   ```bash
   npm run inspect
   ```

   Connect to: `https://your-tunnel-url.trycloudflare.com/sse`

## Scripts Reference

### `start-local-dev.sh`
Automated tunnel setup with guided instructions.

**Usage:**
```bash
./start-local-dev.sh
```

**What it does:**
- Starts Cloudflare tunnel
- Detects HTTPS URL automatically
- Displays configuration instructions
- Keeps tunnel running (Ctrl+C to stop)

### `update-redirect-uri.sh`
Updates `.dev.vars` with new tunnel URL.

**Usage:**
```bash
./update-redirect-uri.sh https://your-tunnel-url.trycloudflare.com
```

**What it does:**
- Backs up `.dev.vars` to `.dev.vars.backup`
- Updates `SCHWAB_REDIRECT_URI` with callback URL
- Shows reminder to update Schwab portal

### `test-oauth.sh`
Testing checklist and troubleshooting guide.

**Usage:**
```bash
./test-oauth.sh
```

**What it does:**
- Checks if `.dev.vars` exists
- Validates configuration
- Shows setup options
- Provides debug tips

## Testing the OAuth Flow

1. **Start the tunnel** (in terminal 1):
   ```bash
   ./start-local-dev.sh
   ```

2. **Start dev server** (in terminal 2):
   ```bash
   npm run dev
   ```

3. **Connect MCP Inspector:**
   - Run: `npm run inspect`
   - Connect to: `https://your-tunnel-url.trycloudflare.com/sse`

4. **Expected flow:**
   - ✓ Approval dialog appears
   - ✓ Redirects to Schwab login
   - ✓ After login, redirects to callback
   - ✓ Returns to MCP Inspector with tools loaded

## Troubleshooting

### "Invalid redirect_uri" Error

**Cause:** Redirect URI mismatch between `.dev.vars` and Schwab portal.

**Solution:**
1. Check the URL in `.dev.vars`
2. Verify it matches exactly in Schwab Developer Portal
3. Ensure it includes `/callback` at the end
4. Restart dev server after changes

### "Missing or invalid access token" Error

**Cause:** Token not stored or expired.

**Solution:**
1. Clear browser cookies for your tunnel URL
2. Check KV storage: `npx wrangler kv:key list --namespace-id=<ID> --local`
3. Ensure OAuth flow completed successfully
4. Check wrangler logs for errors

### Tunnel URL Changes

**Note:** Free Cloudflare tunnels generate a new URL each time.

**Solution:**
1. Stop and restart `start-local-dev.sh`
2. Update `.dev.vars` with new URL
3. Update Schwab Developer Portal with new callback URL
4. Restart dev server

**Pro Tip:** For stable URLs, use named Cloudflare tunnels or ngrok with a reserved domain.

## Alternative: ngrok

If you prefer ngrok:

1. **Install ngrok:**
   ```bash
   brew install ngrok
   ```

2. **Start tunnel:**
   ```bash
   ngrok http 8788
   ```

3. **Update redirect URI:**
   ```bash
   ./update-redirect-uri.sh https://your-ngrok-url.ngrok.io
   ```

4. **Continue with steps 3-5** from Quick Start

## Debug Mode

Enable verbose logging for troubleshooting:

**`.dev.vars`:**
```bash
LOG_LEVEL=debug
```

Then check wrangler terminal output for detailed logs including:
- OAuth state validation
- Token exchange
- API calls
- Error details

## Security Notes

- Tunnel URLs are temporary and public
- Don't commit `.dev.vars` to git (already in `.gitignore`)
- Tokens are encrypted in KV storage
- Cookies use AES-256 encryption
- State parameters are HMAC-signed

## Production Deployment

For production, set a permanent HTTPS redirect URI:

```bash
# Set in Cloudflare Workers
npx wrangler secret put SCHWAB_REDIRECT_URI
# Enter: https://your-worker.workers.dev/callback

# Update Schwab Developer Portal
# Add: https://your-worker.workers.dev/callback
```

See main [README.md](./README.md) for full deployment instructions.
