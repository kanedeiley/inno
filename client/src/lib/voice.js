// Browser side of a voice call: mic -> PCM16 24kHz -> server proxy -> Azure gpt-realtime -> PCM16 -> speakers.
// Handles both GA (response.output_audio.*) and preview (response.audio.*) event names.

const SAMPLE_RATE = 24000;

const WORKLET = `
class MicCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(2400); this.n = 0; this.sum = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.sum += s * s;
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer, level: Math.sqrt(this.sum / this.n) }, [this.buf.buffer]);
        this.buf = new Int16Array(2400); this.n = 0; this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
`;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function pcm16ToFloat(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

export class VoiceCall {
  /** handlers: { onEvent(evt), onLevel(n), onStatus(s), onError(msg) } */
  constructor(handlers) {
    this.h = handlers;
    this.sources = new Set();
    this.playhead = 0;
  }

  async start(sessionId) {
    this.h.onStatus?.('connecting');
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/realtime?sessionId=${encodeURIComponent(sessionId)}`);
    this.ws.onmessage = (m) => this.#onServer(JSON.parse(m.data));
    this.ws.onclose = () => this.stop();
    this.ws.onerror = () => this.h.onError?.('Voice connection failed');

    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-capture');
    this.node.port.onmessage = ({ data }) => {
      this.h.onLevel?.(data.level);
      if (this.ws?.readyState === WebSocket.OPEN && this.live) {
        this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(data.pcm) }));
      }
    };
    this.src.connect(this.node);
  }

  #onServer(evt) {
    switch (evt.type) {
      case 'proxy.connected':
        this.live = true;
        this.h.onStatus?.('live');
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.#play(evt.delta);
        break;
      case 'input_audio_buffer.speech_started':
        this.interrupt(); // barge-in: caller talks over the assistant
        break;
      case 'proxy.error':
      case 'error':
        this.h.onError?.(evt.message || evt.error?.message || 'Realtime error');
        break;
    }
    this.h.onEvent?.(evt);
  }

  #play(b64) {
    const data = pcm16ToFloat(b64);
    const buf = this.ctx.createBuffer(1, data.length, SAMPLE_RATE);
    buf.copyToChannel(data, 0);
    const node = this.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.ctx.destination);
    this.playhead = Math.max(this.playhead, this.ctx.currentTime);
    node.start(this.playhead);
    this.playhead += buf.duration;
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
  }

  interrupt() {
    for (const s of this.sources) s.stop();
    this.sources.clear();
    this.playhead = 0;
  }

  /** Resolves once queued assistant audio has finished playing. */
  async drained() {
    while (this.ctx && this.ctx.state !== 'closed' && this.playhead > this.ctx.currentTime) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.live = false;
    this.interrupt();
    this.ws?.close();
    this.src?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.h.onStatus?.('ended');
  }
}
