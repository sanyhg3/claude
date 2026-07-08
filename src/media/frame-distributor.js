const sessionManager = require('../server/session-manager');

class FrameDistributor {
  constructor() {
    this.droppedFrames = 0;
    this.lastDropLog = 0;
    this.h264Encoder = null; // Will be set by the orchestrator
  }

  setEncoder(encoder) {
    this.h264Encoder = encoder;
  }

  checkBackpressure(ws, info, payloadSize) {
    const limit = 1000000; // 1MB limit for both to allow enough in-flight frames without causing bufferbloat
    let currentBuffer = ws.bufferedAmount || 0;
    
    // Only check WebRTC buffer if we are actually using it (H.264)
    if (info && info.codec === 'h264' && info.rtcDataChannel && info.rtcDataChannel.isOpen()) {
      currentBuffer = info.rtcDataChannel.bufferedAmount();
    }
    
    if (currentBuffer > limit) {
      this.droppedFrames++;
      const now = Date.now();
      if (now - this.lastDropLog > 1000) {
        console.warn(`⚠️ Network flooded! Dropped ${this.droppedFrames} frames. Buffer size: ${(currentBuffer/1024).toFixed(1)}KB`);
        this.droppedFrames = 0;
        this.lastDropLog = now;
      }
      return true;
    }
    return false;
  }

  broadcastJpegFrame(jpegBuffer) {
    for (const [ws, info] of sessionManager.clients) {
      if (info.codec === 'h264' || ws.readyState !== 1) continue;
      if (this.checkBackpressure(ws, info, jpegBuffer.length)) continue;
      ws.send(sessionManager.cachedMetaPayload);
      // ALWAYS use WebSocket for JPEGs. The Node.js WebRTC DataChannel is notoriously 
      // slow at pushing large bulk data and will artificially cap FPS to 5-6 frames.
      // WebSockets use raw TCP and can easily push 60+ FPS of JPEGs.
      ws.send(jpegBuffer, { binary: true });
    }
  }

  broadcastH264Frame(accessUnit) {
    const clients = sessionManager.getH264Clients();
    if (clients.length === 0) return;

    const header = Buffer.alloc(5);
    header.writeUInt8(accessUnit.isKey ? 0x01 : 0x02, 0);
    header.writeUInt32BE(Math.floor(accessUnit.timestamp / 1000), 1);
    const message = Buffer.concat([header, accessUnit.data]);

    for (const [ws, info] of sessionManager.clients) {
      if (info.codec !== 'h264' || ws.readyState !== 1) continue;
      if (this.checkBackpressure(ws, info, message.length)) continue;
      ws.send(sessionManager.cachedMetaPayload);
      
      if (info.rtcDataChannel && info.rtcDataChannel.isOpen()) {
        try {
          info.rtcDataChannel.sendMessageBinary(message);
        } catch (e) {
          ws.send(message, { binary: true });
        }
      } else {
        ws.send(message, { binary: true });
      }
    }
  }

  distributeFrame(jpegBuffer) {
    if (!jpegBuffer) return;
    this.broadcastJpegFrame(jpegBuffer);
    if (this.h264Encoder && sessionManager.getH264Clients().length > 0) {
      this.h264Encoder.feedFrame(jpegBuffer);
    }
  }
}

module.exports = new FrameDistributor();
