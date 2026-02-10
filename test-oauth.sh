#!/bin/bash
# Quick OAuth testing script

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Schwab MCP Local OAuth Test ===${NC}"
echo ""
echo "1. Checking configuration..."

if [ ! -f .dev.vars ]; then
    echo -e "${RED}✗ .dev.vars file not found!${NC}"
    echo "   Create it from .dev.vars.example"
    exit 1
fi

echo -e "${GREEN}✓ .dev.vars exists${NC}"

# Check if required vars are set
if grep -q "your_schwab_app_key_here" .dev.vars 2>/dev/null; then
    echo -e "${YELLOW}⚠️  .dev.vars still contains placeholder values${NC}"
    echo "   Update with your actual Schwab credentials"
fi

echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}IMPORTANT: Schwab requires HTTPS redirect URIs${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}Option 1: Automated Tunnel Setup (Recommended)${NC}"
echo "   Run: ${GREEN}./start-local-dev.sh${NC}"
echo "   This will:"
echo "   • Start a Cloudflare tunnel with HTTPS"
echo "   • Display the callback URL for Schwab portal"
echo "   • Provide step-by-step instructions"
echo ""
echo -e "${BLUE}Option 2: Manual Setup${NC}"
echo "   1. Start tunnel: ${GREEN}cloudflared tunnel --url http://localhost:8788${NC}"
echo "   2. Update .dev.vars with tunnel URL"
echo "   3. Add callback URL to Schwab Developer Portal"
echo "   4. Start dev server: ${GREEN}npm run dev${NC}"
echo "   5. Run MCP Inspector: ${GREEN}npm run inspect${NC}"
echo ""
echo -e "${BLUE}Expected OAuth flow:${NC}"
echo "   ✓ Approval dialog appears"
echo "   ✓ Redirects to Schwab login (https://api.schwabapi.com/)"
echo "   ✓ After login, redirects to your callback URL"
echo "   ✓ Returns to MCP Inspector with tools available"
echo ""
echo -e "${BLUE}Debug tips:${NC}"
echo "  • Check browser console for errors"
echo "  • Check wrangler dev terminal for logs"
echo "  • Set LOG_LEVEL=debug in .dev.vars for verbose logging"
echo "  • Verify redirect URI matches in both .dev.vars and Schwab portal"
echo ""
