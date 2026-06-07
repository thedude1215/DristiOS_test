#!/bin/bash
cd /Users/arnav/Documents/DristiOS-main/electron
echo "Downloading Electron binary..."
ZIP_PATH=$(npx @electron/get --version 33.2.1)
echo "Downloaded zip to: $ZIP_PATH"

echo "Extracting manually..."
rm -rf node_modules/electron/dist/*
unzip -q -o "$ZIP_PATH" -d node_modules/electron/dist/

echo "Creating path.txt..."
echo -n "Electron.app/Contents/MacOS/Electron" > node_modules/electron/path.txt

echo "Starting Electron App..."
npm run dev
