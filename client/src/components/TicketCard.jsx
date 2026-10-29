const FIELDS = [
  ['short_description', 'Short description'],
  ['priority', 'Priority'],
  ['system_id', 'System ID'],
  ['patient_info', 'Patient information'],
  ['modality', 'Modality'],
  ['application', 'Application with issue'],
  ['more_information', 'More information'],
];

export default function TicketCard({ draft, ticket }) {
  const data = ticket || draft || {};
  return (
    <div className={`card ticket ${ticket ? 'done' : ''}`}>
      <div className="card-title">
        Incident
        {ticket ? <span className="pill green">{ticket.number}</span> : <span className="pill">draft</span>}
      </div>
      <dl className="fields">
        {FIELDS.map(([k, label]) => {
          const v = data[k];
          return (
            <div key={k} className={`field ${v ? 'filled' : ''}`}>
              <dt>{label}</dt>
              <dd className={k === 'system_id' ? 'mono' : ''}>
                {k === 'priority' && v ? <span className={`pill ${v === 'Urgent' ? 'red' : ''}`}>{v}</span> : v || '—'}
              </dd>
            </div>
          );
        })}
      </dl>
      {ticket && (
        <div className="ticket-foot">
          Logged {new Date(ticket.created_at).toLocaleTimeString()} · {(ticket.call_duration_ms / 1000).toFixed(1)}s call
        </div>
      )}
    </div>
  );
}
