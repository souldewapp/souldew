#!/bin/bash
# Doppelklick startet souldew (macOS).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Installiere es von https://nodejs.org (LTS) und starte dann erneut."
  read -n 1 -s -r -p "Taste drücken zum Schließen …"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installiere Abhängigkeiten (einmalig) …"
  npm install --no-audit --no-fund || { read -n 1 -s -r -p "npm install fehlgeschlagen – Taste drücken …"; exit 1; }
fi
node server/index.mjs
