import {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  session,
  screen,
  ipcMain,
  nativeImage,
  dialog,
  systemPreferences,
} from 'electron';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isOverlayMode = true;
let serverProcess: ChildProcess | null = null;
let serverManaged = false; // true if we spawned the server ourselves

const HOTKEY = 'CommandOrControl+Shift+V'; // Global hotkey to toggle overlay
const SERVER_URL = 'http://127.0.0.1:3001';
const SERVER_HEALTH_URL = `${SERVER_URL}/health`;

// ── Server Management ──────────────────────────────────────────────

function sendServerStatus(status: 'starting' | 'ready' | 'crashed') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-status', status);
  }
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(SERVER_HEALTH_URL, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(maxWaitMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await checkServerHealth()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startServer(): Promise<void> {
  // Check if server is already running (started externally)
  if (await checkServerHealth()) {
    console.log('[Electron] Server already running at', SERVER_URL);
    sendServerStatus('ready');
    return;
  }

  sendServerStatus('starting');
  console.log('[Electron] Starting server...');

  const serverDir = path.resolve(__dirname, '../../server');
  if (!existsSync(path.join(serverDir, 'package.json'))) {
    console.error('[Electron] Server directory not found at', serverDir);
    sendServerStatus('crashed');
    return;
  }

  // Parse server .env and merge into environment
  const envPath = path.join(serverDir, '.env');
  let serverEnv: Record<string, string> = {};
  if (existsSync(envPath)) {
    try {
      serverEnv = parseDotenv(readFileSync(envPath));
    } catch (err) {
      console.warn('[Electron] Failed to parse server .env:', err);
    }
  }

  const workspacePath = path.resolve(serverDir, '..');
  const mergedEnv = { ...process.env, ...serverEnv, WORKSPACE_PATH: workspacePath };

  serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: mergedEnv,
    stdio: 'pipe',
    // Ensure the server is in its own process group for clean shutdown
    detached: false,
  });
  serverManaged = true;

  serverProcess.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[Server] ${data.toString()}`);
  });

  serverProcess.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[Server:err] ${data.toString()}`);
  });

  serverProcess.on('exit', (code) => {
    console.log(`[Electron] Server process exited with code ${code}`);
    if (serverManaged) {
      sendServerStatus('crashed');
      serverProcess = null;
    }
  });

  // Poll /health until ready
  const ready = await waitForServer();
  if (ready) {
    console.log('[Electron] Server is ready');
    sendServerStatus('ready');
  } else {
    console.error('[Electron] Server failed to start within timeout');
    sendServerStatus('crashed');
  }
}

function killServer() {
  if (serverProcess && !serverProcess.killed) {
    console.log('[Electron] Killing server process...');
    serverManaged = false;
    serverProcess.kill('SIGTERM');
    // Force kill after 3s if still alive
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }, 3000);
    serverProcess = null;
  }
}

async function requestMicrophonePermission() {
  if (process.platform !== 'darwin') return;

  const current = systemPreferences.getMediaAccessStatus('microphone');
  if (current === 'granted') {
    console.log('[Electron] Microphone permission: granted');
    return;
  }

  if (current === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log(`[Electron] Microphone permission: ${granted ? 'granted' : 'denied'}`);
    return;
  }

  console.warn(`[Electron] Microphone permission: ${current}`);
}

function checkScreenRecordingPermission() {
  if (process.platform !== 'darwin') return;

  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') {
    console.log('[Electron] Screen Recording permission: granted');
    return;
  }

  console.warn(`[Electron] Screen Recording permission: ${status}`);
  dialog.showMessageBox({
    type: 'warning',
    title: 'Screen Recording Permission Required',
    message:
      'RCY Voice Agent needs Screen Recording permission for desktop vision and click-by-screenshot tasks.',
    detail:
      'Please go to System Settings → Privacy & Security → Screen Recording and enable this app. Then restart the app.',
    buttons: ['OK'],
    defaultId: 0,
  }).catch(() => {});
}

// ── Accessibility Check ────────────────────────────────────────────

function checkAccessibilityPermission() {
  if (process.platform !== 'darwin') return;

  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!trusted) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Accessibility Permission Required',
      message:
        'RCY Voice Agent needs Accessibility permission for desktop automation (opening apps, controlling windows).',
      detail:
        'Please go to System Settings → Privacy & Security → Accessibility and add this app.',
      buttons: ['Open System Settings', 'Later'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 0) {
        // Prompt macOS to show the accessibility permission dialog
        systemPreferences.isTrustedAccessibilityClient(true);
      }
    });
  } else {
    console.log('[Electron] Accessibility permission: granted');
  }
}

// ── Window Management ──────────────────────────────────────────────

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  // Extra padding around glass for border/shadow effects
  const windowWidth = 740;
  const windowHeight = 390;
  const windowX = Math.floor((screenWidth - windowWidth) / 2);
  const windowY = Math.floor((screenHeight - windowHeight) / 2);

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: windowX,
    y: windowY,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false, // Show in taskbar initially
    resizable: false, // FIXED SIZE - no resizing
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#00000000', // Fully transparent
    hasShadow: true,
    roundedCorners: true,
    vibrancy: 'under-window', // macOS vibrancy effect
    visualEffectState: 'active',
  });

  // Load the renderer
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Enable click-through in overlay mode
  if (isOverlayMode) {
    enableOverlayMode();
  }
}

function enableOverlayMode() {
  if (!mainWindow) return;

  // Make the window click-through except for interactive elements
  // The renderer will handle making specific elements interactive
  mainWindow.setIgnoreMouseEvents(false); // Start with normal interaction
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setSkipTaskbar(true);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  isOverlayMode = true;
}

function disableOverlayMode() {
  if (!mainWindow) return;

  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setSkipTaskbar(false);
  mainWindow.setVisibleOnAllWorkspaces(false);

  isOverlayMode = false;
}

function toggleOverlayMode() {
  if (isOverlayMode) {
    disableOverlayMode();
  } else {
    enableOverlayMode();
  }
}

function toggleWindow() {
  if (!mainWindow) return;
  
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  // Create a simple tray icon
  // For macOS, we can use nativeImage to create a template icon
  const iconPath = path.join(__dirname, 'assets/tray-icon.png');

  // Try to load icon, fallback to creating a simple one
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);

    // If icon doesn't exist or failed to load, create a simple template
    if (trayIcon.isEmpty()) {
      // Create a simple 16x16 icon with a dot in the center
      const size = 16;
      const canvas = Buffer.alloc(size * size * 4);
      // Fill with transparent
      for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = 0;     // R
        canvas[i + 1] = 0; // G
        canvas[i + 2] = 0; // B
        canvas[i + 3] = 0; // A
      }
      // Draw a simple circle in the center
      const centerX = Math.floor(size / 2);
      const centerY = Math.floor(size / 2);
      const radius = 3;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - centerX;
          const dy = y - centerY;
          if (dx * dx + dy * dy <= radius * radius) {
            const idx = (y * size + x) * 4;
            canvas[idx] = 255;     // R
            canvas[idx + 1] = 255; // G
            canvas[idx + 2] = 255; // B
            canvas[idx + 3] = 255; // A
          }
        }
      }
      trayIcon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
    }
  } catch (err) {
    console.error('Failed to create tray icon:', err);
    // Use empty icon as last resort
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: toggleWindow,
    },
    {
      label: isOverlayMode ? 'Disable Overlay Mode' : 'Enable Overlay Mode',
      click: toggleOverlayMode,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip('RCY Voice Agent');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    toggleWindow();
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  await requestMicrophonePermission();

  // Start server first, then create the window
  await startServer();

  createWindow();
  createTray();

  // Check accessibility permission for desktop agent
  checkAccessibilityPermission();
  checkScreenRecordingPermission();

  // Register global hotkey
  const registered = globalShortcut.register(HOTKEY, () => {
    toggleWindow();
  });

  if (!registered) {
    console.error('Hotkey registration failed');
  }

  console.log(`Global hotkey registered: ${HOTKEY}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killServer();
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
  killServer();
});

// Handle IPC for overlay control (optional - for renderer to control overlay)
ipcMain.on('toggle-overlay', () => {
  toggleOverlayMode();
});

ipcMain.on('set-click-through', (_, enabled: boolean) => {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
});
