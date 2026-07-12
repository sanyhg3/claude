class SessionManager {
  constructor() {
    this.clients = new Map();
    this.currentSpecs = { w: 0, h: 0, dpr: 0, ua: '' };
    this.cachedRects = [];
    this.cachedMetaPayload = JSON.stringify({ type: 'meta', url: '', inputRects: [] });
  }

  addClient(ws) {
    this.clients.set(ws, { codec: 'jpeg', isDesktop: false, rtcPeer: null, rtcDataChannel: null });
  }

  removeClient(ws) {
    const info = this.clients.get(ws);
    if (info && info.rtcPeer) {
      info.rtcPeer.close();
    }
    this.clients.delete(ws);
  }

  getClient(ws) {
    return this.clients.get(ws);
  }

  updateClient(ws, data) {
    const info = this.clients.get(ws) || {};
    Object.assign(info, data);
    this.clients.set(ws, info);
  }

  getH264Clients() {
    const out = [];
    for (const [ws, info] of this.clients) {
      if (info.codec === 'h264' && ws.readyState === 1) out.push(ws);
    }
    return out;
  }

  hasMobileClients() {
    for (const [ws, info] of this.clients) {
      if (ws.readyState === 1 && !info.isDesktop) return true;
    }
    return false;
  }

  getJpegClients() {
    const out = [];
    for (const [ws, info] of this.clients) {
      if (info.codec !== 'h264' && ws.readyState === 1) out.push(ws);
    }
    return out;
  }
}

module.exports = new SessionManager();
