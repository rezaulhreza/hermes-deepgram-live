#!/usr/bin/env bash
# Installs Hermes Deepgram Live. Run it from the repo folder.
#
# It copies the plugin into your Hermes folder, asks for your Deepgram key if you have not
# set one, and switches the plugin on. It is the same result as
#   hermes plugins install rezaulhreza/hermes-deepgram-live --enable
set -eu

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
here="$(cd "$(dirname "$0")" && pwd)"
target="$HERMES_HOME/plugins/deepgram-live"
env_file="$HERMES_HOME/.env"

# 1. Copy the plugin. The desktop half rides along in desktop/ and the Hermes desktop app
#    picks it up from there by itself.
mkdir -p "$target/dashboard" "$target/desktop"
cp "$here/plugin.yaml" "$here/__init__.py" "$here/voice_state.py" "$target/"
cp "$here/dashboard/plugin_api.py" "$here/dashboard/manifest.json" "$target/dashboard/"
cp "$here/desktop/plugin.js" "$target/desktop/plugin.js"
echo "Copied the plugin to $target"

# 2. Ask for the key, unless there is one already.
if grep -qs '^DEEPGRAM_API_KEY=.' "$env_file"; then
  echo "Found DEEPGRAM_API_KEY in $env_file, leaving it alone."
elif [ -t 0 ]; then
  echo "Paste your Deepgram API key. It needs the Member role. Nothing shows as you type."
  printf "Key (or press Enter to skip) "
  read -r -s key
  echo
  if [ -n "$key" ]; then
    mkdir -p "$HERMES_HOME"
    [ -e "$env_file" ] || install -m 600 /dev/null "$env_file"
    printf 'DEEPGRAM_API_KEY=%s\n' "$key" >> "$env_file"
    echo "Saved the key to $env_file"
  else
    echo "Skipped. Add DEEPGRAM_API_KEY to $env_file yourself before using it."
  fi
else
  echo "No terminal to ask on. Add DEEPGRAM_API_KEY to $env_file yourself."
fi

# 3. Switch the plugin on.
if command -v hermes >/dev/null 2>&1 && hermes plugins enable deepgram-live </dev/null >/dev/null 2>&1; then
  echo "Enabled deepgram-live."
else
  echo "Could not enable it automatically. Run  hermes plugins enable deepgram-live"
fi

echo "Done. Restart Hermes and the desktop app to start talking."
