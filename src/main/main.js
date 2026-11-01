'use strict';
const { app, protocol } = require('electron');
const { Store } = require('./store');
const { Browser } = require('./browser');
const { McpController } = require('./mcp-server');

protocol.registerSchemesAsPrivileged([
  { scheme: 'izi', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

// Present ourselves as a regular Chrome so sites don't block "Electron".
const chromeVer = process.versions.chrome;
const osPart = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
  : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
app.userAgentFallback = `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer.split('.')[0]}.0.0.0 Safari/537.36`;

if (process.env.IZI_USER_DATA) app.setPath('userData', process.env.IZI_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let browser;
  const urlFromArgv = (argv) => argv.slice(1).find((a) => /^https?:\/\//i.test(a));

  app.on('second-instance', (_e, argv) => {
    if (!browser) return;
    const url = urlFromArgv(argv);
    if (url) browser.createTab({ url });
    if (browser.win.isMinimized()) browser.win.restore();
    browser.win.focus();
  });

  app.whenReady().then(async () => {
    const store = new Store(app.getPath('userData'));
    browser = new Browser(store);
    const mcp = new McpController(browser);
    browser.init();
    const url = urlFromArgv(process.argv);
    if (url) browser.createTab({ url });
    if (store.data.settings.mcp.enabled) await mcp.start();
    app.on('before-quit', () => { store.flush(); mcp.stop(); });
  });

  app.on('window-all-closed', () => app.quit());
}
