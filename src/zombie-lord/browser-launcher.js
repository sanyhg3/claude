const { chromium } = require('playwright');
const path = require('path');
const EventEmitter = require('events');

const fs = require('fs');

const AUTH_FILE = path.join(__dirname, '..', '..', 'auth.json');
class BrowserLauncher extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.activeCDP = null;
    this.saveInterval = null;
    }

  async startNativeBrowser(w, h, dpr, ua, onFrameNavigated) {
    if (this.context) {
      if (this.saveInterval) clearInterval(this.saveInterval);
      try { await this.context.close(); } catch (e) {}
      if (this.browser) {
        try { await this.browser.close(); } catch (e) {}
      }
      this.browser = null;
      this.context = null;
      this.page = null;
      this.activeCDP = null;
      this.saveInterval = null;
    }

    console.log(`🔧 Booting Native Engine: ${w}x${h} (DPR: ${dpr})`);

    try {
      const profilePath = path.join(__dirname, '..', '..', 'browser_profile');
      
      const contextOptions = {
        channel: 'chrome',
        headless: false,
        args: [
          '--disable-spell-checking',
          '--disable-features=SpellcheckService',
          '--window-size=1500,3000',
          '--window-position=0,0',
          '--hide-scrollbars',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-crash-reporter',
          '--disable-accelerated-video-decode',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--enable-gpu',
          '--disable-software-rasterizer',
          '--disable-lcd-text',
          '--enable-font-antialiasing',
          '--disable-blink-features=AutomationControlled'
        ],
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
        viewport: { width: Math.round(w), height: Math.round(h) },
        deviceScaleFactor: dpr,
        userAgent: ua,
        isMobile: true,
        hasTouch: true,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        permissions: ['geolocation'],
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-CH-UA-Mobile': /Windows|Macintosh(?!(.*(?:iPhone|iPad|iPod)))|(Linux(?!.*Android))/i.test(ua || '') ? '?0' : '?1',
          'Sec-CH-UA-Platform': /Windows/i.test(ua || '') ? '"Windows"' : (/iPhone|iPad|iPod|Macintosh|Mac OS/i.test(ua || '') ? '"iOS"' : '"Android"')
        },
        colorScheme: 'no-preference'
      };

      this.context = await chromium.launchPersistentContext(profilePath, contextOptions);
      this.browser = null; // Persistent context doesn't expose the browser object separately

      if (fs.existsSync(AUTH_FILE)) {
        try {
          const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
          if (state.cookies) await this.context.addCookies(state.cookies);
        } catch (e) {}
      }

      this.saveInterval = setInterval(async () => {
        try {
          if (this.context) {
            const cookies = await this.context.cookies();
            fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies, origins: [] }));
          }
        } catch (e) {}
      }, 5000);

      await this.context.addCookies([{ name: 'PREF', value: 'hl=en&tz=America.New_York', domain: '.google.com', path: '/' }]);

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.addEventListener('DOMContentLoaded', () => {
          const style = document.createElement('style');
          style.textContent = `
            body, p, span, div, input, button, textarea {
              font-family: Roboto, -apple-system, sans-serif;
            }
            * {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.appendChild(style);
        });
      });

      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

      try {
        this.activeCDP = await this.page.context().newCDPSession(this.page);
        await this.activeCDP.send('Emulation.setDeviceMetricsOverride', {
          width: Math.round(w),
          height: Math.round(h),
          deviceScaleFactor: dpr,
          mobile: true,
          screenWidth: Math.round(w),
          screenHeight: Math.round(h)
        });
        
        const isWindows = /Windows/i.test(ua || '');
        const isIOS = /iPhone|iPad|iPod|Macintosh|Mac OS/i.test(ua || '') && !isWindows;
        const platformName = isWindows ? 'Windows' : (isIOS ? 'iOS' : 'Android');
        const isDesktop = /Windows|Macintosh(?!(.*(?:iPhone|iPad|iPod)))|(Linux(?!.*Android))/i.test(ua || '');

        await this.activeCDP.send('Network.setUserAgentOverride', {
            userAgent: ua,
            acceptLanguage: 'en-US,en;q=0.9',
            platform: platformName,
            userAgentMetadata: {
                brands: [{ brand: "Chromium", version: "116" }],
                fullVersionList: [],
                fullVersion: "116.0.0.0",
                platform: platformName,
                platformVersion: "",
                architecture: "",
                model: isDesktop ? '' : (isIOS ? 'iPhone' : ''),
                mobile: !isDesktop
            }
        });
      } catch (e) {
        console.error('CDP Initialization Error:', e);
      }

      this.page.on('crash', async () => {
        console.log('💥 Page crashed! Restarting...');
        this.emit('crash');
        await this.startNativeBrowser(w, h, dpr, ua, onFrameNavigated);
      });

      this.page.goto('https://m.facebook.com').catch(e => console.error('Navigation error:', e));
      console.log('✅ Native Browser Ready → Navigating to m.facebook.com');

      if (onFrameNavigated) onFrameNavigated();

      this.page.on('framenavigated', async (frame) => {
        if (frame === this.page.mainFrame()) {
          if (frame.url() === 'about:blank') {
            this.page.goto('https://m.facebook.com').catch(() => {});
          }
          if (onFrameNavigated) onFrameNavigated();
        }
      });
      
      this.emit('ready', { page: this.page, activeCDP: this.activeCDP });

    } catch (e) {
      console.error('Browser Initialization Error:', e);
    }
  }

  async setViewport(w, h, dpr, ua) {
    if (this.page && !this.page.isClosed()) {
      await this.page.setViewportSize({ width: Math.round(w), height: Math.round(h) }).catch(() => {});
    }
    if (this.activeCDP) {
      await this.activeCDP.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(w),
        height: Math.round(h),
        deviceScaleFactor: dpr,
        mobile: true,
        screenWidth: Math.round(w),
        screenHeight: Math.round(h)
      }).catch(() => {});
      if (ua) {
        const isWindows = /Windows/i.test(ua || '');
        const isIOS = /iPhone|iPad|iPod|Macintosh|Mac OS/i.test(ua || '') && !isWindows;
        const platformName = isWindows ? 'Windows' : (isIOS ? 'iOS' : 'Android');
        const isDesktop = /Windows|Macintosh(?!(.*(?:iPhone|iPad|iPod)))|(Linux(?!.*Android))/i.test(ua || '');

        await this.activeCDP.send('Network.setUserAgentOverride', {
            userAgent: ua,
            acceptLanguage: 'en-US,en;q=0.9',
            platform: platformName,
            userAgentMetadata: {
                brands: [{ brand: "Chromium", version: "116" }],
                fullVersionList: [],
                fullVersion: "116.0.0.0",
                platform: platformName,
                platformVersion: "",
                architecture: "",
                model: isDesktop ? '' : (isIOS ? 'iPhone' : ''),
                mobile: !isDesktop
            }
        }).catch(() => {});
      }
    }
  }

  async close() {
    try {
      if (this.saveInterval) clearInterval(this.saveInterval);
      if (this.context) {
        try { 
          const cookies = await this.context.cookies();
          fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies, origins: [] }));
        } catch (e) {}
        await this.context.close();
        this.context = null;
        this.page = null;
        this.activeCDP = null;
        this.saveInterval = null;
      }
    } catch (e) {
      console.error('Browser close error:', e);
    }
  }

  isPageReady() {
    return this.page && !this.page.isClosed();
  }
}

module.exports = new BrowserLauncher();
