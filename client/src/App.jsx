import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceCall } from './lib/voice.js';
import CallerPanel from './components/CallerPanel.jsx';
import TicketCard from './components/TicketCard.jsx';
import Transcript from './components/Transcript.jsx';

const api = async (url, body) => {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};

export default function App() {
  const [mode, setMode] = useState('voice');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState('idle'); // idle | connecting | live | ended
  const [session, setSession] = useState(null);
  const [caller, setCaller] = useState(null);
  const [draft, setDraft] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [clock, setClock] = useState({ start: null, end: null, now: Date.now() });
  const [health, setHealth] = useState(null);

  const voiceRef = useRef(null);

  useEffect(() => {
    api('/api/health').then(setHealth).catch(() => setHealth({ ok: false }));
  }, []);

  useEffect(() => {
    if (!clock.start || clock.end) return;
    const t = setInterval(() => setClock((c) => ({ ...c, now: Date.now() })), 100);
    return () => clearInterval(t);
  }, [clock.start, clock.end]);

  const upsert = useCallback((id, role, patch) => {
    setMessages((list) => {
      const i = list.findIndex((m) => m.id === id);
      if (i === -1) return [...list, { id, role, text: '', ...patch(null) }];
      const next = list.slice();
      next[i] = { ...next[i], ...patch(next[i]) };
      return next;
    });
  }, []);

  const addEvent = (text, tone) => setMessages((l) => [...l, { id: crypto.randomUUID(), role: 'event', text, tone }]);

  const onTicket = (t) => {
    addEvent(`Logged ${t.number} · ${t.application} · ${t.priority}`, 'ok');
    setTicket(t);
    setDraft(t);
    setClock((c) => ({ ...c, end: Date.now() }));
  };

  // Server events shared by chat responses and the voice socket (voice ones arrive prefixed with "proxy.").
  const onServerEvent = (e) => {
    switch (e.type) {
      case 'lookup':
        addEvent(
          e.matches.length === 1 ? `Matched ${e.matches[0].name} → ${e.matches[0].workstation}`
            : e.matches.length > 1 ? `${e.matches.length} matches for “${e.name}”`
            : `No dashboard match for “${e.name}”`,
        );
        break;
      case 'caller.identified':
        setCaller(e.caller);
        break;
      case 'ticket.draft':
        setDraft(e.draft);
        break;
      case 'ticket.submitted':
        onTicket(e.ticket);
        break;
    }
  };

  function reset() {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setBusy(false);
    setSession(null);
    setCaller(null);
    setDraft(null);
    setTicket(null);
    setMessages([]);
    setError('');
    setStatus('idle');
    setClock({ start: null, end: null, now: Date.now() });
  }

  async function startCall() {
    reset();
    setError('');
    try {
      const { session: s, greeting } = await api('/api/session', { phone, mode });
      setSession(s);
      setCaller(s.caller);
      setDraft(s.draft);
      if (mode === 'chat') {
        setMessages([{ id: 'greet', role: 'assistant', text: greeting }]);
        setStatus('live');
        setClock({ start: Date.now(), end: null, now: Date.now() });
        return;
      }
      const call = new VoiceCall({
        onStatus: (st) => {
          setStatus(st);
          if (st === 'live') setClock({ start: Date.now(), end: null, now: Date.now() });
          if (st === 'ended') setLevel(0);
        },
        onLevel: setLevel,
        onError: setError,
        onEvent: (evt) => handleVoiceEvent(evt, call),
      });
      voiceRef.current = call;
      await call.start(s.id);
    } catch (e) {
      setError(e.message);
      setStatus('idle');
    }
  }

  function handleVoiceEvent(evt, call) {
    switch (evt.type) {
      case 'input_audio_buffer.committed':
        upsert(evt.item_id, 'user', () => ({ pending: true }));
        break;
      case 'conversation.item.input_audio_transcription.completed':
        upsert(evt.item_id, 'user', () => ({ text: evt.transcript?.trim() || '(inaudible)', pending: false }));
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        upsert(evt.item_id, 'assistant', (m) => ({ text: (m?.text || '') + evt.delta }));
        break;
      case 'proxy.thinking':
        setBusy(evt.on);
        break;
      case 'proxy.call.complete':
        // Closing line has been generated; hang up once it has finished playing.
        call.drained().then(() => setTimeout(() => call.stop(), 600));
        break;
      default:
        if (evt.type.startsWith('proxy.')) onServerEvent({ ...evt, type: evt.type.slice(6) });
    }
  }

  async function sendChat(text) {
    if (!text.trim() || !session) return;
    setMessages((l) => [...l, { id: crypto.randomUUID(), role: 'user', text }]);
    setBusy(true);
    try {
      const res = await api('/api/chat', { sessionId: session.id, message: text });
      res.events.forEach(onServerEvent);
      setMessages((l) => [...l, { id: crypto.randomUUID(), role: 'assistant', text: res.reply }]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const inCall = status === 'connecting' || status === 'live';
  const elapsed = clock.start ? ((clock.end || clock.now) - clock.start) / 1000 : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◎</span>
          Radiology IT Helpdesk
        </div>
        <div className={`timer ${ticket ? (elapsed <= 15 ? 'good' : 'slow') : ''}`} title="Time from first word to ticket logged">
          {clock.start ? `${elapsed.toFixed(1)}s` : '—'}
          {ticket && <span className="timer-label">to log</span>}
        </div>
      </header>

      {health && !health.azureConfigured && (
        <div className="banner">Azure isn’t configured. Copy <code>.env.example</code> to <code>.env</code> and restart the server.</div>
      )}

      <main className="layout">
        <aside className="side">
          <CallerPanel phone={phone} setPhone={setPhone} disabled={inCall} caller={caller} session={session} />
          <TicketCard draft={draft} ticket={ticket} />
        </aside>

        <section className="call">
          <div className="call-head">
            <div className="seg" role="tablist">
              {['voice', 'chat'].map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} disabled={inCall} onClick={() => setMode(m)}>
                  {m === 'voice' ? 'Voice' : 'Chat'}
                </button>
              ))}
            </div>
            {inCall ? (
              <button className="btn danger" onClick={() => (mode === 'voice' ? voiceRef.current?.stop() : setStatus('ended'))}>
                End {mode === 'voice' ? 'call' : 'chat'}
              </button>
            ) : (
              <button className="btn primary" onClick={startCall}>
                {status === 'ended' ? 'New call' : mode === 'voice' ? 'Start call' : 'Start chat'}
              </button>
            )}
          </div>

          <Transcript
            messages={messages}
            mode={mode}
            status={status}
            busy={busy}
            level={level}
            error={error}
            onSend={sendChat}
            done={Boolean(ticket)}
          />
        </section>
      </main>
    </div>
  );
}
