#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

if [ -z "$1" ]; then
    echo -e "${RED}Usage: $0 <tunnel-url>${NC}"
    echo -e "Example: $0 https://random-words-123.trycloudflare.com"
    exit 1
fi

TUNNEL_URL=$1
CALLBACK_URL="${TUNNEL_URL}/callback"

# Remove trailing slash if present
TUNNEL_URL=${TUNNEL_URL%/}
CALLBACK_URL="${TUNNEL_URL}/callback"

echo -e "${BLUE}Updating .dev.vars with redirect URI...${NC}\n"

if [ ! -f .dev.vars ]; then
    echo -e "${RED}✗ .dev.vars file not found${NC}"
    exit 1
fi

# Backup existing .dev.vars
cp .dev.vars .dev.vars.backup

# Update the redirect URI
if grep -q "SCHWAB_REDIRECT_URI=" .dev.vars; then
    # Replace existing line
    sed -i '' "s|SCHWAB_REDIRECT_URI=.*|SCHWAB_REDIRECT_URI=${CALLBACK_URL}|g" .dev.vars
    echo -e "${GREEN}✓ Updated SCHWAB_REDIRECT_URI in .dev.vars${NC}"
else
    # Add new line if it doesn't exist
    echo "SCHWAB_REDIRECT_URI=${CALLBACK_URL}" >> .dev.vars
    echo -e "${GREEN}✓ Added SCHWAB_REDIRECT_URI to .dev.vars${NC}"
fi

echo ""
echo -e "${BLUE}New redirect URI:${NC} ${GREEN}${CALLBACK_URL}${NC}"
echo ""
echo -e "${YELLOW}Don't forget to:${NC}"
echo "1. Add this URL to your Schwab Developer Portal"
echo "2. Restart your dev server (npm run dev)"
echo ""
echo -e "${BLUE}Backup saved as:${NC} .dev.vars.backup"
