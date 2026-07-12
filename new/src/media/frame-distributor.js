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
    const limit = 200000;
    const currentBuffer = ws.bufferedAmount || 0;  // always WS now
    if (currentBuffer > limit) {
      this.droppedFrames++;
      const now = Date.now();
      if (now - this.lastDropLog > 1000) {
        console.warn(`⚠️ Dropped ${this.droppedFrames}. Buffer: ${(currentBuffer/1024).toFixed(1)}KB`);
        this.droppedFrames = 0; this.lastDropLog = now;
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
      ws.send(message, { binary: true }); // WebSocket, skip slow node-datachannel
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
