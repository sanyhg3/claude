const { WebSocketServer } = require('ws');
const sessionManager = require('./session-manager');
const webrtcSignaling = require('./webrtc-signaling');
const { launcher, controller, screencast } = require('../zombie-lord');
const { H264Encoder, checkFFmpeg } = require('../media/encoder');
const frameDistributor = require('../media/frame-distributor');

const FFMPEG_OK = checkFFmpeg();
console.log(FFMPEG_OK
  ? '✅ FFmpeg found — H.264 encoding available'
  : '⚠️  FFmpeg not found — JPEG-only mode');

class WSServer {
  constructor() {
    this.wss = null;
    this.isCapturing = false;
    this.captureWakeup = null;
    this.h264Encoder = null;
    this.fastCaptureUntil = 0;
    this.activeMode = null;
  }

  init(server) {
    this.wss = new WebSocketServer({ server });
    
    // Poll input rects every second
    setInterval(async () => {
      if (launcher.isPageReady()) {
        sessionManager.cachedRects = await controller.getInputRects();
        sessionManager.cachedMetaPayload = JSON.stringify({
          type: 'meta',
          url: launcher.page.url(),
          inputRects: sessionManager.cachedRects
        });
      }
    }, 1000);

    const heartbeat = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('connection', async (ws, req) => {
      console.log('🔗 Client connected');
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });

      try { if (ws._socket) ws._socket.setNoDelay(true); } catch (err) {}
      sessionManager.addClient(ws);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        try {
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
            return;
          }

          switch (msg.type) {
            case 'init': {
              const codec = (msg.codec === 'h264' && FFMPEG_OK) ? 'h264' : 'jpeg';
              const isDesktop = !!msg.isDesktop;
              sessionManager.updateClient(ws, { codec, isDesktop, reqSpecs: { w: msg.w, h: msg.h, dpr: msg.dpr, ua: msg.ua } });
              console.log(`${isDesktop ? '🖥️ ' : '📱'} Client init: ${msg.w}×${msg.h} DPR:${msg.dpr} codec:${codec}`);

              const newMode = isDesktop ? 'desktop' : 'mobile';
              const targetSpecs = { w: msg.w, h: msg.h, dpr: msg.dpr, ua: msg.ua };

              let needsReload = false;
              // Check if we need to switch the active capture mode
              if (this.activeMode && this.activeMode !== newMode) {
                if (screencast.isNativeActive) screencast.stopNativeScreencast();
                this.isCapturing = false;
                
                // Destroy encoder so it restarts with the correct GOP profile (Full-screen for PC vs Delta for Mobile)
                if (this.h264Encoder) {
                  this.h264Encoder.destroy();
                  this.h264Encoder = null;
                }

                // FORCE PAGE RELOAD TO FIX CHROMIUM VIEWPORT/SCREENCAST LATENCY BUG
                // If Chromium dynamically changes from mobile to desktop without a reload, startScreencast permanently loses hardware acceleration.
                if (launcher.isPageReady()) {
                  needsReload = true;
                  launcher.page.reload().catch(() => {});
                }
              }
              this.activeMode = newMode;

              // Use the client's exact user agent, falling back to a default if not provided
              if (!targetSpecs.ua) {
                console.warn("⚠️ Client didn't send UA! Defaulting to Android fallback.");
                targetSpecs.ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';
              }

              const isDead = !launcher.isPageReady();
              const specs = sessionManager.currentSpecs;
              const uaChanged = specs.ua !== targetSpecs.ua;
              const specsChanged = specs.w !== targetSpecs.w || specs.h !== targetSpecs.h || specs.dpr !== targetSpecs.dpr || uaChanged;

              if (uaChanged && !isDead) {
                needsReload = true;
                this.isCapturing = false;
                if (screencast.isNativeActive) screencast.stopNativeScreencast();
              }

              if (isDead) {
                this.isCapturing = false;
                if (this.h264Encoder) { this.h264Encoder.destroy(); this.h264Encoder = null; }

                sessionManager.currentSpecs = targetSpecs;
                await launcher.startNativeBrowser(targetSpecs.w, targetSpecs.h, targetSpecs.dpr, targetSpecs.ua, isDesktop, async () => {
                  this.isCapturing = false;
                  if (sessionManager.clients.size > 0) this.ensureCapture();
                });
              } else if (specsChanged) {
                sessionManager.currentSpecs = targetSpecs;
                await launcher.setViewport(targetSpecs.w, targetSpecs.h, targetSpecs.dpr, targetSpecs.ua, isDesktop);
                if (this.h264Encoder) { this.h264Encoder.destroy(); this.h264Encoder = null; }
                
                if (uaChanged && needsReload) {
                   console.log('🔄 UA changed, reloading page to fetch correct device HTML...');
                   launcher.page.reload().catch(() => {});
                }

                const vpMsg = JSON.stringify({ type: 'viewport_changed', w: targetSpecs.w, h: targetSpecs.h, dpr: targetSpecs.dpr });
                for (const [cWs] of sessionManager.clients) {
                  if (cWs.readyState === 1) cWs.send(vpMsg);
                }
              }

              ws.hasInitialized = true;

              if (codec === 'h264') this.ensureEncoder();

              ws.send(JSON.stringify({ type: 'codec', codec, ffmpeg: FFMPEG_OK }));
              if (!needsReload) {
                this.ensureCapture();
              }

              if (codec === 'h264' && this.h264Encoder && this.h264Encoder.getLastKeyframe()) {
                const kf = this.h264Encoder.getLastKeyframe();
                const header = Buffer.alloc(5);
                header.writeUInt8(0x01, 0);
                header.writeUInt32BE(Math.floor(kf.timestamp / 1000), 1);
                ws.send(sessionManager.cachedMetaPayload);
                ws.send(Buffer.concat([header, kf.data]), { binary: true });
              }
              break;
            }

            case 'webrtc_offer':
              webrtcSignaling.handleOffer(ws, msg);
              break;

            case 'webrtc_ice':
              webrtcSignaling.handleIce(ws, msg);
              break;

            case 'navigate':
              await controller.navigate(msg.url);
              break;
            case 'back':
              await controller.goBack();
              break;
            case 'forward':
              await controller.goForward();
              break;
            case 'tap':
              await controller.clickAt(msg.x, msg.y);
              this.triggerCapture();
              break;
            case 'scroll':
              await controller.scroll(msg.dy);
              this.triggerCapture();
              break;
            case 'touchStart':
            case 'touchMove':
            case 'touchEnd':
              await controller.dispatchTouch(msg.type, msg.x, msg.y);
              this.triggerCapture();
              break;
            case 'mousedown':
              await controller.mouseMove(msg.x, msg.y);
              await controller.mouseDown();
              this.triggerCapture();
              break;
            case 'mousemove':
              await controller.mouseMove(msg.x, msg.y, 2);
              this.triggerCapture();
              break;
            case 'mouseup':
              await controller.mouseUp();
              this.triggerCapture();
              break;
            case 'type':
              await controller.insertText(msg.text);
              this.triggerCapture();
              break;
            case 'key':
              await controller.pressKey(msg.key);
              this.triggerCapture();
              break;
            case 'keydown':
              await controller.keyDown(msg.key);
              this.triggerCapture();
              break;
            case 'keyup':
              await controller.keyUp(msg.key);
              this.triggerCapture();
              break;
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      });

      ws.on('close', () => {
        sessionManager.removeClient(ws);
        console.log('🔌 Client disconnected');
        this.destroyEncoderIfUnneeded();

        if (sessionManager.clients.size === 0) {
          this.isCapturing = false;
          screencast.stopNativeScreencast();
          this.activeMode = null;
        } else {
          // Last connected device takes over!
          let lastClient = null;
          for (const [cWs, info] of sessionManager.clients) {
            lastClient = info;
          }
          if (lastClient) {
            const newMode = lastClient.isDesktop ? 'desktop' : 'mobile';
            if (this.activeMode !== newMode) {
              if (screencast.isNativeActive) screencast.stopNativeScreencast();
              this.isCapturing = false;
              this.activeMode = newMode;
            }
            const pcSpecs = lastClient.reqSpecs;
            if (pcSpecs) {
              const specsChanged = sessionManager.currentSpecs.w !== pcSpecs.w || sessionManager.currentSpecs.h !== pcSpecs.h;
              if (specsChanged) {
                sessionManager.currentSpecs = pcSpecs;
                launcher.setViewport(pcSpecs.w, pcSpecs.h, pcSpecs.dpr, pcSpecs.ua).then(() => {
                  const vpMsg = JSON.stringify({ type: 'viewport_changed', w: pcSpecs.w, h: pcSpecs.h, dpr: pcSpecs.dpr });
                  for (const [cWs] of sessionManager.clients) {
                    if (cWs.readyState === 1) cWs.send(vpMsg);
                  }
                }).catch(() => {});
              }
            }
            this.ensureCapture();
          }
        }
      });
    });

    this.wss.on('close', () => { clearInterval(heartbeat); });

    launcher.on('crash', () => {
      this.isCapturing = false;
    });
  }

  sleep(ms) {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.captureWakeup = null;
        resolve();
      }, ms);
      this.captureWakeup = () => {
        clearTimeout(timeout);
        this.captureWakeup = null;
        resolve();
      };
    });
  }

  triggerCapture() {
    this.fastCaptureUntil = Date.now() + 500;
    screencast.fastCaptureUntil = this.fastCaptureUntil;
    if (this.captureWakeup) this.captureWakeup();
  }

  async captureLoop() {
    if (this.isCapturing) return;
    this.isCapturing = true;
    console.log('📹 High-DPI Capture loop started');

    let isMyCapture = true;

    while (sessionManager.clients.size > 0 && launcher.isPageReady() && this.activeMode === 'mobile') {
      if (!this.isCapturing) {
        isMyCapture = false;
        break;
      }

      const start = Date.now();
      // Mobile source quality set to 60 (different from PC)
      const frame = await screencast.captureFrame(60);
      if (frame) frameDistributor.distributeFrame(frame);
      
      // If we are actively interacting, bump to 20 FPS. Otherwise drop to 10 FPS to save CPU.
      const targetFps = Date.now() < this.fastCaptureUntil ? 20 : 10;
      const targetMs = 1000 / targetFps;
      const elapsed = Date.now() - start;
      const delay = Math.max(0, targetMs - elapsed);
      if (delay > 0) {
        await this.sleep(delay);
      }
    }

    if (isMyCapture && this.activeMode === 'mobile') {
      this.isCapturing = false;
      console.log('📹 Capture loop stopped');
    }
  }

  ensureCapture() {
    if (this.isCapturing) return;

    if (this.activeMode === 'mobile') {
      screencast.stopNativeScreencast();
      this.captureLoop();
    } else if (sessionManager.clients.size > 0 && this.activeMode === 'desktop') {
      this.isCapturing = true;
      console.log('🖥️ Native Desktop Screencast started');
      screencast.startNativeScreencast((frame) => {
        frameDistributor.distributeFrame(frame);
      });
    }
  }

  ensureEncoder() {
    if (!FFMPEG_OK || this.h264Encoder) return;

    const specs = sessionManager.currentSpecs;
    const pixelW = Math.round(specs.w * specs.dpr);
    const pixelH = Math.round(specs.h * specs.dpr);

    this.h264Encoder = new H264Encoder(pixelW, pixelH, this.activeMode === 'desktop');
    frameDistributor.setEncoder(this.h264Encoder);

    this.h264Encoder.on('frame', (accessUnit) => frameDistributor.broadcastH264Frame(accessUnit));
    this.h264Encoder.on('error', (err) => {
      console.error('Encoder error:', err.message);
    });
    console.log('🎬 H.264 encoder started');
  }

  destroyEncoderIfUnneeded() {
    if (!this.h264Encoder) return;
    if (sessionManager.getH264Clients().length === 0) {
      this.h264Encoder.destroy();
      this.h264Encoder = null;
      frameDistributor.setEncoder(null);
      console.log('🎬 H.264 encoder stopped (no H.264 clients)');
    }
  }

  shutdown() {
    if (this.h264Encoder) this.h264Encoder.destroy();
    screencast.stopNativeScreencast();
  }
}

module.exports = new WSServer();
