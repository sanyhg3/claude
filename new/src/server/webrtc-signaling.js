const nodeDataChannel = require('node-datachannel');
const sessionManager = require('./session-manager');

class WebRTCSignaling {
  handleOffer(ws, msg) {
    const client = sessionManager.getClient(ws);
    if (!client) return;
    
    if (client.rtcPeer) client.rtcPeer.close();

    const pc = new nodeDataChannel.PeerConnection('Server', { iceServers: ['stun:stun.l.google.com:19302'] });
    client.rtcPeer = pc;

    pc.onLocalDescription((sdp, type) => {
      ws.send(JSON.stringify({ type: 'webrtc_answer', answer: { type: 'answer', sdp } }));
    });

    pc.onLocalCandidate((candidate, mid) => {
      ws.send(JSON.stringify({ type: 'webrtc_ice', candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 } }));
    });

    pc.onDataChannel((dc) => {
      client.rtcDataChannel = dc;
      dc.onOpen(() => console.log('✅ Server UDP DataChannel open'));
      dc.onClosed(() => client.rtcDataChannel = null);
    });

    pc.setRemoteDescription(msg.offer.sdp, msg.offer.type);
  }

  handleIce(ws, msg) {
    const client = sessionManager.getClient(ws);
    if (client && client.rtcPeer && msg.candidate) {
       client.rtcPeer.addRemoteCandidate(msg.candidate.candidate, msg.candidate.sdpMid);
    }
  }
}

module.exports = new WebRTCSignaling();
