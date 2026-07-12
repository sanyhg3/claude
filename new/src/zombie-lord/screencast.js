const launcher = require('./browser-launcher');

class Screencast {
  constructor() {
    this.isNativeActive = false;
    this.onFrameCallback = null;
    this.lastFrameTime = 0;
    this.fastCaptureUntil = 0;
    
    this.pendingFrameTimeout = null;

    this._handleScreencastFrame = async (payload) => {
      if (!this.isNativeActive) return;
      
      const now = Date.now();
      const targetFps = now < this.fastCaptureUntil ? 20 : 10;
      const minDelay = 1000 / targetFps;
      const elapsed = now - this.lastFrameTime;

      // Always ACK immediately so Chromium isn't blocked from rendering the next frame
      if (launcher.activeCDP) {
        launcher.activeCDP.send('Page.screencastFrameAck', {
          sessionId: payload.sessionId
        }).catch(() => {});
      }

      const buffer = Buffer.from(payload.data, 'base64');

      if (elapsed < minDelay) {
        // Frame arrived too fast. Keep it as a pending "tail" frame.
        // This ensures we NEVER permanently drop the final state of an animation!
        if (this.pendingFrameTimeout) clearTimeout(this.pendingFrameTimeout);
        
        const remainingTime = minDelay - elapsed;
        this.pendingFrameTimeout = setTimeout(() => {
          this.pendingFrameTimeout = null;
          this.lastFrameTime = Date.now();
          if (this.onFrameCallback && this.isNativeActive) {
            this.onFrameCallback(buffer);
          }
        }, remainingTime);
        return;
      }

      // If enough time has passed, send immediately and clear any stale tail frame
      if (this.pendingFrameTimeout) {
        clearTimeout(this.pendingFrameTimeout);
        this.pendingFrameTimeout = null;
      }

      this.lastFrameTime = now;
      if (this.onFrameCallback) this.onFrameCallback(buffer);
    };
  }

  /**
   * Capture a single frame using Page.screenshot.
   * Unlike Page.startScreencast, this correctly honors the deviceScaleFactor
   * to capture true High-DPI (Retina) pixels for perfectly crisp output.
   */
  async captureFrame(quality = 80) {
    if (!launcher.isPageReady()) return null;
    try {
      return await launcher.page.screenshot({ fullPage: false, type: 'jpeg', quality: 60, timeout: 500, caret: 'initial' });
    } catch (e) {
      return null;
    }
  }

  async startNativeScreencast(onFrame) {
    if (!launcher.isPageReady() || !launcher.activeCDP) return;
    if (this.isNativeActive) return;

    this.isNativeActive = true;
    this.onFrameCallback = onFrame;
    
    try {
      launcher.activeCDP.off('Page.screencastFrame', this._handleScreencastFrame);
      await launcher.activeCDP.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 55, // Restore high quality source for H.264 encoding
        everyNthFrame: 1
      });
      launcher.activeCDP.on('Page.screencastFrame', this._handleScreencastFrame);
    } catch (e) {
      console.error('Failed to start native screencast:', e.message);
      this.isNativeActive = false;
      
      // If we failed because the page is mid-navigation, retry in 500ms
      setTimeout(() => {
        if (!this.isNativeActive && this.onFrameCallback) {
          console.log('🔄 Retrying native screencast start...');
          this.startNativeScreencast(this.onFrameCallback);
        }
      }, 500);
    }
  }

  async stopNativeScreencast() {
    this.isNativeActive = false;
    if (launcher.activeCDP) {
      try {
        launcher.activeCDP.off('Page.screencastFrame', this._handleScreencastFrame);
        await launcher.activeCDP.send('Page.stopScreencast');
      } catch (e) {}
    }
  }
}

module.exports = new Screencast();
