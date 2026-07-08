const launcher = require('./browser-launcher');

class CDPController {
  
  async getInputRects() {
    try {
      if (!launcher.isPageReady()) return [];
      return await launcher.page.evaluate(() => {
        const selectors = 'input:not([type=hidden]), textarea, [contenteditable="true"], [role="textbox"]';
        return Array.from(document.querySelectorAll(selectors)).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
      });
    } catch {
      return [];
    }
  }

  async navigate(url) {
    if (!launcher.isPageReady()) return;
    return launcher.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }

  async goBack() {
    if (!launcher.isPageReady()) return;
    return launcher.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  async goForward() {
    if (!launcher.isPageReady()) return;
    return launcher.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  async tap(x, y) {
    if (!launcher.isPageReady()) return;
    return launcher.page.touchscreen.tap(x, y).then(() => {
      setTimeout(() => {
        if (!launcher.isPageReady()) return;
        launcher.page.evaluate(() => {
          const el = document.activeElement;
          if (el && (['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable)) {
            el.scrollIntoView({ block: 'center' });
          }
        }).catch(() => {});
      }, 300);
    }).catch(() => {});
  }

  async scroll(dy) {
    if (!launcher.isPageReady()) return;
    return launcher.page.mouse.wheel(0, dy).catch(() => {});
  }

  async dispatchTouch(type, x, y) {
    if (launcher.activeCDP) {
      const pts = type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y), id: 0 }];
      return launcher.activeCDP.send('Input.dispatchTouchEvent', { type, touchPoints: pts }).catch(() => {});
    }
  }

  async mouseMove(x, y, steps = 1) {
    if (!launcher.isPageReady()) return;
    return launcher.page.mouse.move(x, y, { steps }).catch(() => {});
  }

  async mouseDown(button = 'left') {
    if (!launcher.isPageReady()) return;
    return launcher.page.mouse.down({ button }).catch(() => {});
  }

  async mouseUp(button = 'left') {
    if (!launcher.isPageReady()) return;
    return launcher.page.mouse.up({ button }).catch(() => {});
  }

  async insertText(text) {
    if (launcher.activeCDP) {
      launcher.activeCDP.send('Input.insertText', { text }).catch(() => {});
    } else if (launcher.isPageReady()) {
      launcher.page.keyboard.insertText(text).catch(() => {});
    }
  }

  async pressKey(key) {
    if (!launcher.isPageReady()) return;
    launcher.page.keyboard.press(key).catch(() => {});
  }

  async keyDown(key) {
    if (!launcher.isPageReady()) return;
    launcher.page.keyboard.down(key).catch(() => {});
  }

  async keyUp(key) {
    if (!launcher.isPageReady()) return;
    launcher.page.keyboard.up(key).catch(() => {});
  }
}

module.exports = new CDPController();
