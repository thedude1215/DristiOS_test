#!/bin/bash
cd /Users/arnav/Documents/DristiOS-main/electron

echo "Cleaning up broken install..."
rm -rf node_modules/electron/dist
mkdir -p node_modules/electron/dist

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  URL="https://github.com/electron/electron/releases/download/v33.2.1/electron-v33.2.1-darwin-arm64.zip"
else
  URL="https://github.com/electron/electron/releases/download/v33.2.1/electron-v33.2.1-darwin-x64.zip"
fi

echo "Downloading Electron binary directly from GitHub ($ARCH)..."
curl -L -o electron.zip "$URL"

echo "Extracting binary..."
unzip -q -o electron.zip -d node_modules/electron/dist/
rm electron.zip

echo "Setting up paths..."
printf "Electron.app/Contents/MacOS/Electron" > node_modules/electron/path.txt

echo "Starting Electron App..."
npm run dev
