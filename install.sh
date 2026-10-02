#!/usr/bin/env sh
# Copies this plugin into your Hermes folder. Run it from the repo folder.
set -eu

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
here="$(cd "$(dirname "$0")" && pwd)"

backend="$HERMES_HOME/plugins/deepgram-live"
desktop="$HERMES_HOME/desktop-plugins/deepgram-live"

mkdir -p "$backend/dashboard" "$desktop"
cp "$here/plugin.yaml" "$here/__init__.py" "$here/voice_state.py" "$backend/"
cp "$here/dashboard/plugin_api.py" "$here/dashboard/manifest.json" "$backend/dashboard/"
cp "$here/desktop/plugin.js" "$desktop/plugin.js"

echo "Installed to $HERMES_HOME"
echo "Next, add DEEPGRAM_API_KEY to $HERMES_HOME/.env, enable deepgram-live, then restart Hermes."
