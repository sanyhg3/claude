const { chromium } = require('playwright');
const path = require('path');

const fs = require('fs');

const AUTH_FILE = path.join(__dirname, 'auth.json');

(async () => {
  console.log('🌐 Opening your saved profile for manual setup...');
  console.log('💡 Close the physical browser window when you are finished.');

  const profilePath = path.join(__dirname, 'browser_profile');
  
  const contextOptions = {
    channel: 'chrome',
    headless: false, 
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: null // This forces it to open as a normal, resizable desktop window!
  };
  
  const context = await chromium.launchPersistentContext(profilePath, contextOptions);
  
  if (fs.existsSync(AUTH_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (state.cookies) await context.addCookies(state.cookies);
    } catch (e) {}
  }
  
  const pages = context.pages();
  if (pages.length === 0) await context.newPage();

  // Periodically save storage state so login info isn't lost if killed abruptly
  const saveInterval = setInterval(async () => {
    try {
      const cookies = await context.cookies();
      fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies, origins: [] }));
      console.log('💾 Storage state saved.');
    } catch (e) {
      console.error('Failed to save storage state:', e);
    }
  }, 10000);

  // Automatically kills this script when you hit the 'X' on the browser window
  context.on('close', async () => {
    clearInterval(saveInterval);
    try {
      const cookies = await context.cookies();
      fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies, origins: [] }));
    } catch (e) {}
    console.log('✅ Browser closed safely. You can restart your main server now.');
    process.exit(0);
  });
})();
