const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');

const ffmpegPath = require('ffmpeg-static');

/**
 * Check if FFmpeg is available on the system PATH.
 */
function checkFFmpeg() {
  try {
    if (!ffmpegPath) return false;
    execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * H.264 encoder that wraps FFmpeg as a child process.
 * 
 * Accepts JPEG frames via feedFrame(), encodes to H.264 Baseline with
 * ultra-low-latency settings, and emits 'frame' events with complete
 * Annex-B access units.
 * 
 * Events:
 *   'frame' → { data: Buffer, isKey: boolean, timestamp: number }
 *   'error' → Error
 */
class H264Encoder extends EventEmitter {
  constructor(width, height, isDesktop = false) {
    super();
    this.width = width;
    this.height = height;
    this.isDesktop = isDesktop;
    this.process = null;
    this.destroyed = false;
    this.lastKeyframe = null;
    this.startTime = Date.now();
    this.frameCount = 0;

    // Output buffering — zerolatency FFmpeg flushes per-frame,
    // we debounce stdout chunks to collect complete access units
    this._outputChunks = [];
    this._flushTimer = null;

    this._spawn();
  }

  _spawn() {
    if (this.destroyed) return;

    this.process = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      // Prevent FFmpeg from buffering frames to analyze the stream
      '-analyzeduration', '0',
      '-probesize', '32',
      // Input: JPEG image sequence from stdin
      '-f', 'image2pipe',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-framerate', '10',
      '-codec:v', 'mjpeg',
      '-i', 'pipe:0',
      // Ensure even dimensions (x264 requires width/height divisible by 2)
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      // Encoder: H.264 Baseline, ultra-low latency
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-pix_fmt', 'yuv420p',
      // GOP: All-Intra (1) for Desktop full-screen updates. Delta (20) for Mobile low-bandwidth.
      '-g', this.isDesktop ? '1' : '20',
      '-x264-params', `keyint=${this.isDesktop ? '1:min-keyint=1' : '20:min-keyint=20'}:repeat-headers=1`,
      // Quality: CRF-based for consistent sharpness at any resolution
      '-crf', '26',
      '-maxrate', '2500000',
      '-bufsize', '5000000',
      // Output: raw H.264 Annex-B stream to stdout
      '-flush_packets', '1',
      '-f', 'h264',
      '-an',
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process.stdout.on('data', (chunk) => {
      this._outputChunks.push(chunk);
      // Debounce: with zerolatency, FFmpeg flushes each encoded frame
      // in a burst of stdout writes. A 3ms gap signals frame boundary.
      clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => this._flush(), 3);
    });

    this.process.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.startsWith('frame=')) {
        console.error('[FFmpeg]', msg);
      }
    });

    this.process.on('error', (err) => {
      console.error('[FFmpeg] Process error:', err.message);
      this.emit('error', err);
    });

    this.process.on('close', (code) => {
      if (!this.destroyed) {
        console.warn(`[FFmpeg] Exited with code ${code}, restarting in 1s...`);
        this.process = null;
        setTimeout(() => this._spawn(), 1000);
      }
    });

    // Suppress stdin EPIPE errors (FFmpeg may close stdin early)
    this.process.stdin.on('error', () => {});
  }

  /**
   * Feed a JPEG frame buffer to the encoder.
   */
  feedFrame(jpegBuffer) {
    if (this.destroyed || !this.process || !this.process.stdin.writable) return false;
    try {
      return this.process.stdin.write(jpegBuffer);
    } catch (e) {
      return false;
    }
  }

  /**
   * Flush accumulated output chunks as a complete access unit.
   */
  _flush() {
    if (this._outputChunks.length === 0) return;

    const data = Buffer.concat(this._outputChunks);
    this._outputChunks = [];

    const isKey = this._containsKeyframe(data);
    const timestamp = (Date.now() - this.startTime) * 1000; // microseconds

    const unit = { data, isKey, timestamp };
    if (isKey) this.lastKeyframe = unit;

    this.frameCount++;
    this.emit('frame', unit);
  }

  /**
   * Scan buffer for IDR (NAL type 5) or SPS (NAL type 7) start codes
   * to determine if this access unit is a keyframe.
   */
  _containsKeyframe(buf) {
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf[i] !== 0) continue;
      if (buf[i + 1] !== 0) { i++; continue; }

      let nalByte = -1;
      if (buf[i + 2] === 1) {
        nalByte = i + 3;
      } else if (buf[i + 2] === 0 && buf[i + 3] === 1) {
        nalByte = i + 4;
      }

      if (nalByte >= 0 && nalByte < buf.length) {
        const nalType = buf[nalByte] & 0x1F;
        if (nalType === 5 || nalType === 7) return true;
      }
    }
    return false;
  }

  /**
   * Get the most recently encoded keyframe (for sending to new clients).
   */
  getLastKeyframe() {
    return this.lastKeyframe;
  }

  /**
   * Destroy the encoder and kill FFmpeg.
   */
  destroy() {
    this.destroyed = true;
    clearTimeout(this._flushTimer);

    if (this.process) {
      try { this.process.stdin.end(); } catch (e) {}
      try { this.process.kill(); } catch (e) {}
      this.process = null;
    }

    this.removeAllListeners();
  }
}

module.exports = { H264Encoder, checkFFmpeg };
