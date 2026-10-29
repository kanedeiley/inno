import { useEffect, useState } from 'react';

const fmt = (d) => (d?.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
const REASONS = {
  invalid_phone: 'Not a valid number',
  phone_not_found: 'Number not in phone directory',
  workstation_not_on_dashboard: 'Workstation not on active dashboard',
};

export default function CallerPanel({ phone, setPhone, disabled, caller, session }) {
  const [preview, setPreview] = useState(null);
  const [directory, setDirectory] = useState([]);

  useEffect(() => {
    fetch('/api/directory').then((r) => r.json()).then(setDirectory).catch(() => {});
  }, []);

  // Live caller-ID preview as the number is typed.
  useEffect(() => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return setPreview(null);
    const t = setTimeout(() => {
      fetch(`/api/lookup?phone=${encodeURIComponent(phone)}`).then((r) => r.json()).then(setPreview).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [phone]);

  // During/after a call, show what the session knows (may be updated by name lookup).
  const shown = session ? (caller ? { ok: true, caller } : session.lookup) : preview;
  const identifiedByName = session && caller && !session.lookup?.ok;

  return (
    <div className="card">
      <div className="card-title">Caller ID</div>
      <input
        className="input mono"
        placeholder="Incoming number (optional)"
        value={phone}
        disabled={disabled}
        onChange={(e) => setPhone(e.target.value)}
        inputMode="tel"
      />
      {!disabled && directory.length > 0 && (
        <div className="chips">
          {directory.map((d) => (
            <button key={d.phone} className="chip" onClick={() => setPhone(fmt(d.phone))} title={d.workstation}>
              {d.name ? d.name.split(',')[0] : 'Unknown'}
              <span className="chip-sub">{d.phone.slice(-4)}</span>
            </button>
          ))}
          <button className="chip ghost" onClick={() => setPhone('')}>No caller ID</button>
        </div>
      )}

      {shown?.ok && (
        <div className="who">
          <div className="who-name">
            {shown.caller.name}
            <span className={`pill ${identifiedByName ? 'blue' : 'green'}`}>{identifiedByName ? 'by name' : 'caller ID'}</span>
          </div>
          <div className="who-meta">
            <span className="mono">{shown.caller.workstation}</span> · {shown.caller.site || shown.caller.location}
            {shown.caller.role && <> · {shown.caller.role}</>}
          </div>
          {shown.caller.study && (
            <div className="who-study">
              <div>{shown.caller.study.procedure}</div>
              <div className="muted">{shown.caller.study.patient} · {shown.caller.study.accession}</div>
            </div>
          )}
        </div>
      )}
      {shown && !shown.ok && (
        <div className="who warn">
          {REASONS[shown.reason] || 'Not identified'}
          {shown.workstation && <span className="mono"> ({shown.workstation})</span>}
          <div className="muted">Assistant will ask for the caller’s name.</div>
        </div>
      )}
    </div>
  );
}
