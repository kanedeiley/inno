import { WebSocket, WebSocketServer } from 'ws';
import { getSession, greeting, nextTurn, recordAgent, TRANSCRIBE_PROMPT } from './agent.js';

const API = (process.env.AZURE_OPENAI_REALTIME_API || 'ga').toLowerCase();

// The realtime model is only the voice: the server decides every line (see agent.js nextTurn).
const VOICE_INSTRUCTIONS =
  'You are the voice of a radiology IT helpdesk. Speak in a calm, friendly, brisk tone. ' +
  'Only ever say the exact line you are given for each response, in English, with nothing added.';

function upstreamUrl() {
  if (process.env.AZURE_OPENAI_REALTIME_URL) return process.env.AZURE_OPENAI_REALTIME_URL;
  const host = new URL(process.env.AZURE_OPENAI_ENDPOINT).host;
  const dep = encodeURIComponent(process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || 'gpt-realtime');
  return API === 'preview'
    ? `wss://${host}/openai/realtime?api-version=${process.env.AZURE_OPENAI_REALTIME_API_VERSION || '2025-04-01-preview'}&deployment=${dep}`
    : `wss://${host}/openai/v1/realtime?model=${dep}`;
}

function sessionUpdate() {
  const voice = process.env.REALTIME_VOICE || 'alloy';
  const transcription = { model: process.env.REALTIME_TRANSCRIBE_MODEL || 'whisper-1', language: 'en', prompt: TRANSCRIBE_PROMPT };
  // create_response:false — VAD only detects turns; the server creates every response after deciding what to say.
  const turn_detection = { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 500, create_response: false };

  if (API === 'preview') {
    return {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: VOICE_INSTRUCTIONS,
        voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: transcription,
        turn_detection,
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: VOICE_INSTRUCTIONS,
      output_modalities: ['audio'],
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice },
      },
    },
  };
}

const CLIENT_ALLOWED = new Set(['input_audio_buffer.append', 'input_audio_buffer.clear']);

export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/realtime') return socket.destroy();
    const session = getSession(url.searchParams.get('sessionId'));
    if (!session) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, session));
  });
}

function bridge(client, session) {
  const upstream = new WebSocket(upstreamUrl(), { headers: { 'api-key': process.env.AZURE_OPENAI_API_KEY } });
  const pending = [];
  const sendUp = (obj) => (upstream.readyState === WebSocket.OPEN ? upstream.send(JSON.stringify(obj)) : pending.push(obj));
  const sendClient = (obj) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(obj));

  // Only one response may be active at a time; queue the next line until the current one is done.
  let responding = false;
  let queuedLine = null;
  let closeAfterSpeaking = false;
  let turns = Promise.resolve(); // caller utterances are processed strictly in order

  const speak = (line) => {
    if (responding) {
      queuedLine = line;
      return;
    }
    responding = true;
    recordAgent(session, line);
    sendUp({ type: 'response.create', response: { instructions: `Say exactly this and nothing else: "${line}"` } });
  };

  upstream.on('open', () => {
    upstream.send(JSON.stringify(sessionUpdate()));
    for (const m of pending.splice(0)) upstream.send(JSON.stringify(m));
    sendClient({ type: 'proxy.connected' });
    speak(greeting(session));
  });

  upstream.on('message', (data) => {
    const text = data.toString();
    let evt;
    try {
      evt = JSON.parse(text);
    } catch {
      return;
    }

    switch (evt.type) {
      case 'conversation.item.input_audio_transcription.completed': {
        const utterance = evt.transcript?.trim();
        if (!utterance || session.ticket) break;
        turns = turns.then(async () => {
          sendClient({ type: 'proxy.thinking', on: true });
          const { say, events, done } = await nextTurn(session, utterance, 'voice');
          console.log(`[turn] caller: "${utterance}" -> say: ${say ? `"${say}"` : '(silent)'}`);
          sendClient({ type: 'proxy.thinking', on: false });
          for (const e of events) sendClient({ type: `proxy.${e.type}`, ...e });
          if (done) closeAfterSpeaking = true;
          if (say) speak(say);
        });
        break;
      }
      case 'input_audio_buffer.speech_started':
        // Barge-in: stop the line being spoken; the caller's new utterance drives the next one.
        if (responding) sendUp({ type: 'response.cancel' });
        queuedLine = null;
        break;
      case 'session.updated':
        console.log('[realtime] session configured (server-driven flow)');
        break;
      case 'response.done':
        responding = false;
        if (queuedLine) {
          const line = queuedLine;
          queuedLine = null;
          speak(line);
        } else if (closeAfterSpeaking) {
          sendClient({ type: 'proxy.call.complete' });
        }
        break;
      case 'error':
        console.error('[realtime] upstream error', evt.error);
        break;
    }

    if (client.readyState === WebSocket.OPEN) client.send(text);
  });

  upstream.on('close', (code, reason) => {
    sendClient({ type: 'proxy.closed', code, reason: reason.toString() });
    client.close();
  });
  upstream.on('error', (err) => {
    console.error('[realtime] upstream socket error', err.message);
    sendClient({ type: 'proxy.error', message: err.message });
    client.close();
  });

  client.on('message', (data) => {
    try {
      const evt = JSON.parse(data.toString());
      if (CLIENT_ALLOWED.has(evt.type)) sendUp(evt);
    } catch {}
  });
  client.on('close', () => upstream.close());
}
