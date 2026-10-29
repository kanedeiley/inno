import crypto from 'node:crypto';
import { lookupByName, lookupByPhone, isWorkstationActive, MODALITIES, APPLICATIONS } from './data.js';
import { saveTicket } from './tickets.js';

// ---------- sessions ----------
// One session per simulated call. Holds everything we knew before the call plus the ticket draft.
const sessions = new Map();

export function createSession({ phone } = {}) {
  const lookup = phone ? lookupByPhone(phone) : null;
  const caller = lookup?.ok ? lookup.caller : null;
  const session = {
    id: crypto.randomUUID(),
    phone: phone || null,
    lookup,
    caller,
    draft: draftFromCaller(caller),
    ticket: null,
    chat: [],
    startedAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export const getSession = (id) => sessions.get(id);

export function publicSession(s) {
  return { id: s.id, phone: s.phone, lookup: s.lookup, caller: s.caller, draft: s.draft, ticket: s.ticket };
}

function draftFromCaller(caller) {
  return {
    short_description: '',
    priority: 'Moderate',
    system_id: caller?.workstation || '',
    patient_info: caller?.study ? `${caller.study.patient} — Acc ${caller.study.accession}` : 'N/A',
    modality: caller?.study?.modality || '',
    application: '',
    more_information: '',
  };
}

// ---------- prompt ----------
export function buildInstructions(session, mode) {
  const c = session.caller;
  const known = c
    ? [
        `Caller IDENTIFIED from caller ID (${session.phone}). Do NOT ask their name or workstation.`,
        `- Name (Account): ${c.name} (${c.role || 'staff'})`,
        `- Workstation / System ID: ${c.workstation} at ${c.site || c.location || 'unknown site'}`,
        c.study
          ? `- Open study on that workstation: ${c.study.procedure}, patient ${c.study.patient}, accession ${c.study.accession} (modality ${c.study.modality})`
          : '- No study currently open.',
      ].join('\n')
    : session.phone
      ? `Caller ID ${session.phone} did not match an active workstation (${session.lookup?.reason}). Caller is UNIDENTIFIED.`
      : 'No caller ID. Caller is UNIDENTIFIED.';

  const greeting = c
    ? `"Hi ${spokenName(c.name)}, Radiology IT. What's going on?"`
    : `"Radiology IT, who am I speaking with?"`;

  const closing =
    mode === 'voice'
      ? `"Got it, it's logged and someone will follow up shortly."  (don't read the ticket number aloud; it's on screen)`
      : `"Logged as <ticket_number>. Someone will follow up shortly."`;

  return `You are the Radiology IT helpdesk ${mode === 'voice' ? 'phone line' : 'chat'}. Callers are busy radiologists and techs.
GOAL: get a complete ticket logged in under 15 seconds. Be short and warm: one brief sentence per turn, no filler, no apologies, never recite the ticket back.

KNOWN BEFORE THE CALL
${known}

FLOW
1. Open with exactly: ${greeting}
2. If unidentified: when they give a name, call lookup_caller_by_name. If one match, confirm the workstation in a few words ("You're on RADWS-014?"). If several, ask which one. If none, ask for the System ID on the PC sticker.
3. Once you know what's wrong, infer every field yourself. Ask ONE quick follow-up only if the problem is too vague to act on (e.g. "it's broken" with no app or symptom). Never ask for priority, modality, or patient info unless the issue is clearly about a specific patient/study that isn't the open study.
4. Call submit_ticket immediately, then say: ${closing}

FIELD RULES for submit_ticket
- short_description: <= 80 chars, technician-friendly, e.g. "PowerScribe freezing during dictation on RADWS-014".
- priority: "Urgent" if they say STAT, urgent, ED/trauma, patient on table/waiting, can't read at all, or system down; otherwise "Moderate".
- system_id: the workstation ID.
- patient_info: if the issue involves the open study, use it; if they name another patient, use that; else "N/A".
- modality: one of ${MODALITIES.join(' | ')}. Use the open study's modality if relevant, otherwise infer, otherwise "Other".
- application: one of ${APPLICATIONS.join(' | ')}.
  Hints: dictation/voice recognition/reports -> PowerscribeOne; images/viewer/hanging protocols -> Sectra or GE Viewpoint (whichever they name, else Sectra); worklist/orders/exam status -> Epic Radiant; outside CD/images -> Ambra Outside Image; breast MRI CAD -> DynaCAD; breast density -> Volpara; stroke/perfusion -> Rapid; mouse/monitor/PC/login/printer -> Physician Workstation Issue; "call me back" -> Radiologist Requesting Call Back.
- more_information: the caller's own words plus anything useful (error text, when it started).`;
}

/** "Patel, Anika" -> "Anika" */
export function spokenName(account) {
  const [last, first] = String(account).split(',').map((s) => s.trim());
  return first ? first.split(/\s+/)[0] : last;
}

// ---------- tools ----------
const TOOL_SPECS = [
  {
    name: 'lookup_caller_by_name',
    description: "Find the caller's workstation by their name (matched against the dashboard Account field).",
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Caller name as spoken/typed' } },
      required: ['name'],
    },
  },
  {
    name: 'submit_ticket',
    description: 'Log the radiology IT incident. Call as soon as you know what is wrong.',
    parameters: {
      type: 'object',
      properties: {
        short_description: { type: 'string', description: 'Max 80 characters' },
        priority: { type: 'string', enum: ['Moderate', 'Urgent'] },
        system_id: { type: 'string', description: 'Workstation / PC System ID' },
        patient_info: { type: 'string', description: 'Name, DOB, MRN, Accession — or N/A' },
        modality: { type: 'string', enum: MODALITIES },
        application: { type: 'string', enum: APPLICATIONS },
        more_information: { type: 'string' },
      },
      required: ['short_description', 'priority', 'system_id', 'patient_info', 'modality', 'application'],
    },
  },
];

export const chatTools = TOOL_SPECS.map((t) => ({ type: 'function', function: t }));
export const realtimeTools = TOOL_SPECS.map((t) => ({ type: 'function', ...t }));

/**
 * Runs a tool for a session. Returns { output, events } where events are pushed to the UI
 * so the caller panel / ticket card update live.
 */
export function runTool(session, name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
  } catch {
    return { output: { error: 'invalid JSON arguments' }, events: [] };
  }

  if (name === 'lookup_caller_by_name') {
    const matches = lookupByName(args.name);
    if (matches.length === 1) {
      session.caller = matches[0];
      session.draft = { ...draftFromCaller(matches[0]), ...pickFilled(session.draft, ['short_description', 'more_information']) };
      return {
        output: { found: true, name: matches[0].name, workstation: matches[0].workstation, site: matches[0].site, open_study: matches[0].study },
        events: [{ type: 'caller.identified', caller: session.caller, draft: session.draft }],
      };
    }
    if (matches.length > 1) {
      return { output: { found: 'multiple', candidates: matches.map((m) => ({ name: m.name, workstation: m.workstation, site: m.site })) }, events: [] };
    }
    return { output: { found: false }, events: [] };
  }

  if (name === 'submit_ticket') {
    if (session.ticket) return { output: { already_logged: true, ticket_number: session.ticket.number }, events: [] };
    const fields = {
      short_description: String(args.short_description || '').slice(0, 80),
      priority: args.priority === 'Urgent' ? 'Urgent' : 'Moderate',
      system_id: String(args.system_id || session.draft.system_id || '').toUpperCase(),
      patient_info: args.patient_info?.trim() || 'N/A',
      modality: MODALITIES.includes(args.modality) ? args.modality : 'Other',
      application: APPLICATIONS.includes(args.application) ? args.application : 'Other',
      more_information: String(args.more_information || ''),
    };
    const ticket = saveTicket({
      ...fields,
      caller_name: session.caller?.name || null,
      caller_phone: session.phone,
      system_id_on_dashboard: isWorkstationActive(fields.system_id),
      call_duration_ms: Date.now() - session.startedAt,
    });
    session.draft = fields;
    session.ticket = ticket;
    return { output: { logged: true, ticket_number: ticket.number }, events: [{ type: 'ticket.submitted', ticket }] };
  }

  return { output: { error: `unknown tool ${name}` }, events: [] };
}

function pickFilled(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj?.[k]).map((k) => [k, obj[k]]));
}
