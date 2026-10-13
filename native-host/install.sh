#!/bin/sh
# Registers the native host with Chrome. Extension ID is fixed by "key" in manifest.json.
set -e
HOST_NAME=com.margin.host
EXT_ID=jedifjjnfhphgclibpkfijfemogochoh
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
chmod +x "$DIR/host.py"
mkdir -p "$DEST"
cat > "$DEST/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Margin: mirrors notes to SQLite and keeps the ChatGPT sign-in",
  "path": "$DIR/host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "Installed $DEST/$HOST_NAME.json"
