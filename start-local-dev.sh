#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Schwab MCP Local Development Setup ===${NC}\n"

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}✗ cloudflared is not installed${NC}"
    echo "Install it with: brew install cloudflared"
    exit 1
fi

echo -e "${GREEN}✓ cloudflared is installed${NC}\n"

# Check if .dev.vars exists
if [ ! -f .dev.vars ]; then
    echo -e "${RED}✗ .dev.vars file not found${NC}"
    echo "Copy .dev.vars.example to .dev.vars and configure it"
    exit 1
fi

echo -e "${GREEN}✓ .dev.vars file exists${NC}\n"

# Create a temporary file to store the tunnel URL
TUNNEL_URL_FILE="/tmp/schwab-mcp-tunnel-url"
rm -f "$TUNNEL_URL_FILE"

echo -e "${YELLOW}Starting Cloudflare Tunnel...${NC}"
echo -e "${BLUE}This will expose http://localhost:8788 via HTTPS${NC}\n"

# Start cloudflared in background and capture output
cloudflared tunnel --url http://localhost:8788 2>&1 | tee >(
    while IFS= read -r line; do
        # Extract the HTTPS URL from cloudflared output
        if echo "$line" | grep -q "https://.*\.trycloudflare\.com"; then
            TUNNEL_URL=$(echo "$line" | grep -o "https://[^[:space:]]*\.trycloudflare\.com")
            echo "$TUNNEL_URL" > "$TUNNEL_URL_FILE"

            # Display the configuration instructions
            echo ""
            echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo -e "${GREEN}✓ Tunnel started successfully!${NC}"
            echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo ""
            echo -e "${YELLOW}Next steps:${NC}"
            echo ""
            echo -e "${BLUE}1. Update .dev.vars with this redirect URI:${NC}"
            echo -e "   ${GREEN}SCHWAB_REDIRECT_URI=${TUNNEL_URL}/callback${NC}"
            echo ""
            echo -e "${BLUE}2. Configure Schwab Developer Portal:${NC}"
            echo -e "   • Go to: ${GREEN}https://developer.schwab.com${NC}"
            echo -e "   • Edit your app"
            echo -e "   • Add redirect URI: ${GREEN}${TUNNEL_URL}/callback${NC}"
            echo -e "   • Save changes"
            echo ""
            echo -e "${BLUE}3. Start the dev server (in another terminal):${NC}"
            echo -e "   ${GREEN}npm run dev${NC}"
            echo ""
            echo -e "${BLUE}4. Connect MCP Inspector to:${NC}"
            echo -e "   ${GREEN}${TUNNEL_URL}/sse${NC}"
            echo ""
            echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo ""
            echo -e "${YELLOW}Press Ctrl+C to stop the tunnel${NC}"
            echo ""
        fi
    done
) &

# Wait for the tunnel URL file to be created or timeout after 15 seconds
TIMEOUT=15
ELAPSED=0
while [ ! -f "$TUNNEL_URL_FILE" ] && [ $ELAPSED -lt $TIMEOUT ]; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

# If tunnel didn't start within timeout, show error
if [ ! -f "$TUNNEL_URL_FILE" ]; then
    echo -e "${RED}✗ Failed to start tunnel within ${TIMEOUT} seconds${NC}"
    echo "Check the output above for errors"
    exit 1
fi

# Keep the script running
wait
