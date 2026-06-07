#!/bin/bash
echo "Starting Server..."
cd /Users/arnav/Documents/DristiOS-main/server
npm install
npm run dev > /tmp/rcy-server-web.log 2>&1 &
SERVER_PID=$!

echo "Starting Web Client..."
cd /Users/arnav/Documents/DristiOS-main/client
npm install
npm run dev
