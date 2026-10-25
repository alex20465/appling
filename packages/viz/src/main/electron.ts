import { app, BrowserWindow, screen } from 'electron';

const [url, parent] = process.argv.slice(-2);
const WIDTH = 560;
const HEIGHT = 460;
const MARGIN = 16;

/** A frameless window above every other window, top right of the primary display, that does not take the focus. */
app.whenReady().then(() => {
    const { workArea } = screen.getPrimaryDisplay();
    const window = new BrowserWindow({
        width: WIDTH, height: HEIGHT, minWidth: 360, minHeight: 280,
        x: workArea.x + workArea.width - WIDTH - MARGIN, y: workArea.y + MARGIN,
        frame: false, alwaysOnTop: true, skipTaskbar: true, show: false, title: 'Appling', backgroundColor: '#0c0a08'
    });
    if (process.platform === 'darwin') {
        window.setAlwaysOnTop(true, 'floating');
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.once('ready-to-show', () => window.showInactive());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.loadURL(url);
});

app.on('window-all-closed', () => app.quit());

/** Ends with the MCP server that started it, even when that one was killed. */
setInterval(() => {
    try {
        process.kill(Number(parent), 0);
    } catch {
        app.quit();
    }
}, 2000);
