import { WebSocket, WebSocketServer } from 'ws';
import { buildInstructions, getSession, realtimeTools, runTool } from './agent.js';

const API = (process.env.AZURE_OPENAI_REALTIME_API || 'ga').toLowerCase();

function upstreamUrl() {
  if (process.env.AZURE_OPENAI_REALTIME_URL) return process.env.AZURE_OPENAI_REALTIME_URL;
  const host = new URL(process.env.AZURE_OPENAI_ENDPOINT).host;
  const dep = encodeURIComponent(process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || 'gpt-realtime');
  return API === 'preview'
    ? `wss://${host}/openai/realtime?api-version=${process.env.AZURE_OPENAI_REALTIME_API_VERSION || '2025-04-01-preview'}&deployment=${dep}`
    : `wss://${host}/openai/v1/realtime?model=${dep}`;
}

function sessionUpdate(session) {
  const instructions = buildInstructions(session, 'voice');
  const voice = process.env.REALTIME_VOICE || 'alloy';
  const transcription = { model: process.env.REALTIME_TRANSCRIBE_MODEL || 'whisper-1' };
  // Short silence window keeps turns snappy; callers on a helpdesk line talk in short bursts.
  const turn_detection = { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 250, silence_duration_ms: 450 };

  if (API === 'preview') {
    return {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions,
        voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: transcription,
        turn_detection,
        tools: realtimeTools,
        tool_choice: 'auto',
        temperature: 0.7,
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions,
      output_modalities: ['audio'],
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice },
      },
      tools: realtimeTools,
      tool_choice: 'auto',
    },
  };
}

// Only these client events are forwarded; everything else (session config, tools) is server-owned.
const CLIENT_ALLOWED = new Set(['input_audio_buffer.append', 'input_audio_buffer.clear', 'response.cancel', 'conversation.item.truncate']);

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

  upstream.on('open', () => {
    upstream.send(JSON.stringify(sessionUpdate(session)));
    // Model speaks first with the greeting from its instructions.
    upstream.send(JSON.stringify({ type: 'response.create' }));
    for (const m of pending.splice(0)) upstream.send(JSON.stringify(m));
    sendClient({ type: 'proxy.connected' });
  });

  upstream.on('message', (data) => {
    const text = data.toString();
    let evt;
    try {
      evt = JSON.parse(text);
    } catch {
      return;
    }

    if (evt.type === 'response.function_call_arguments.done') {
      const { output, events } = runTool(session, evt.name, evt.arguments);
      sendClient({ type: 'proxy.tool', name: evt.name, args: evt.arguments, output });
      for (const e of events) sendClient({ type: `proxy.${e.type}`, ...e });
      sendUp({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify(output) } });
      sendUp({ type: 'response.create' });
    }
    if (evt.type === 'error') console.error('[realtime] upstream error', evt.error);

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
