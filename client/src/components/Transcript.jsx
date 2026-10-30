import { useEffect, useRef, useState } from 'react';

export default function Transcript({ messages, mode, status, busy, level, error, onSend, done }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);
  useEffect(() => {
    if (mode === 'chat' && status === 'live' && !busy) inputRef.current?.focus();
  }, [mode, status, busy]);

  const submit = (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <>
      <div className="transcript">
        {messages.length === 0 && status === 'idle' && (
          <div className="empty">
            <p>Pick a caller ID (or leave it blank), then start a {mode === 'voice' ? 'call' : 'chat'}.</p>
            <p className="muted">Target: issue logged in under 15 seconds.</p>
          </div>
        )}
        {status === 'connecting' && <div className="empty muted">Connecting…</div>}
        {messages.map((m) =>
          m.role === 'event' ? (
            <div key={m.id} className={`event ${m.tone || ''}`}>{m.text}</div>
          ) : (
            <div key={m.id} className={`bubble ${m.role}`}>
              {m.pending && !m.text ? <span className="dots"><i /><i /><i /></span> : m.text}
            </div>
          ),
        )}
        {busy && <div className="bubble assistant"><span className="dots"><i /><i /><i /></span></div>}
        {done && status !== 'live' && <div className="event ok">Call complete</div>}
        <div ref={endRef} />
      </div>

      {error && <div className="error">{error}</div>}

      {mode === 'chat' ? (
        <form className="composer" onSubmit={submit}>
          <input
            ref={inputRef}
            className="input"
            placeholder={status === 'live' ? 'Type as the caller…' : 'Start a chat to begin'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={status !== 'live' || done}
          />
          <button className="btn primary" disabled={status !== 'live' || busy || !text.trim() || done}>Send</button>
        </form>
      ) : (
        <div className="voicebar">
          <div className={`orb ${status === 'live' ? 'live' : ''}`} style={{ '--lvl': Math.min(1, level * 8) }} />
          <span className="muted">
            {status === 'live' ? 'Listening, just talk' : status === 'connecting' ? 'Connecting…' : 'Mic off'}
          </span>
        </div>
      )}
    </>
  );
}
