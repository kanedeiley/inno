import crypto from 'node:crypto';
import { AzureOpenAI } from 'openai';
import { lookupByName, lookupByPhone, isWorkstationActive, MODALITIES, APPLICATIONS } from './data.js';
import { saveTicket } from './tickets.js';

// The server owns the conversation. After every caller utterance (typed or transcribed) gpt-4o extracts
// the ticket fields from the whole transcript, then nextTurn() picks the next line. The realtime model only
// voices that line, so it can never claim "logged" before the ticket is actually saved.

// ---------- sessions ----------
const sessions = new Map();

export function createSession({ phone } = {}) {
  const lookup = phone ? lookupByPhone(phone) : null;
  const caller = lookup?.ok ? lookup.caller : null;
  const session = {
    id: crypto.randomUUID(),
    phone: phone || null,
    lookup,
    caller,
    identifiedBy: caller ? 'phone' : null,
    draft: draftFromCaller(caller),
    ticket: null,
    transcript: [], // { role: 'agent' | 'caller', text }
    lastLookupName: null,
    candidates: null,
    askedApplication: false,
    lastSay: null,
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
    // Only the workstation is known for sure; everything else comes from what the caller says.
    system_id: caller?.workstation || '',
    patient_info: '',
    modality: '',
    application: '',
    more_information: '',
  };
}

/** "Patel, Anika" -> "Anika" */
export function spokenName(account) {
  const [last, first] = String(account).split(',').map((s) => s.trim());
  return first ? first.split(/\s+/)[0] : last;
}

/** Vocabulary hint for speech-to-text so product names don't come back as "PowerSquad". */
export const TRANSCRIBE_PROMPT =
  'Radiology IT helpdesk call. Terms: PowerScribe One, Sectra, Epic Radiant, Epic Mammography, GE Viewpoint, Ambra, DynaCAD, Volpara, Rapid, PACS, worklist, hanging protocol, dictation, accession, MRN, CT, MRI, ultrasound, mammo, DEXA, fluoro, nuclear medicine, workstation.';

export const greeting = (session) =>
  session.caller ? `Hi ${spokenName(session.caller.name)}, Radiology IT. What's going on?` : 'Radiology IT, who am I speaking with?';

export function recordAgent(session, text) {
  if (!text) return;
  session.lastSay = text;
  session.transcript.push({ role: 'agent', text });
}

// ---------- extraction (gpt-4o) ----------
let client;
export function llm() {
  client ??= new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_CHAT_API_VERSION || '2024-10-21',
    deployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o',
  });
  return client;
}

const str = { type: 'string' };
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    last_utterance: { type: 'string', enum: ['info', 'filler', 'unintelligible'] },
    caller_name: str,
    system_id: str,
    problem: str,
    short_description: str,
    priority: { type: 'string', enum: ['Moderate', 'Urgent'] },
    patient_info: str,
    modality: { type: 'string', enum: MODALITIES },
    application: { type: 'string', enum: [...APPLICATIONS, 'Unknown'] },
    more_information: str,
  },
  required: [
    'last_utterance', 'caller_name', 'system_id', 'problem', 'short_description',
    'priority', 'patient_info', 'modality', 'application', 'more_information',
  ],
};

function extractPrompt(session) {
  const c = session.caller;
  const context = c
    ? `Caller: ${c.name} on workstation ${c.workstation}.` +
      (c.study ? ` Study open on that workstation (only relevant if the caller refers to it): ${c.study.procedure}, ${c.study.patient}, accession ${c.study.accession}, modality ${c.study.modality}.` : '')
    : 'Caller not yet identified.';

  return `You extract radiology IT helpdesk ticket fields from a call transcript. Use ONLY what the caller said; never invent.
Speech-to-text is imperfect: treat sound-alikes as the product ("power scribe", "powersquad", "PS1" = PowerscribeOne; "spectra" = Sectra; "radiant" = Epic Radiant; "viewpoint" = GE Viewpoint; "amber" = Ambra Outside Image).

CONTEXT: ${context}

FIELDS
- last_utterance: classify ONLY the caller's final line. "filler" = thanks/ok/bye/greeting/noise with no new information. "unintelligible" = garbled words that don't make sense. Otherwise "info".
- caller_name: the caller's name as they gave it across the call, else "".
- system_id: a workstation / PC / system ID the caller stated (e.g. "RADWS-014"), else "".
- problem: what is wrong, in the caller's words. "" if they haven't described a problem yet. Naming only an app ("PowerScribe") is not a problem; "PowerScribe won't let me log in" is.
- short_description: <= 80 chars for a technician, e.g. "Cannot log in to PowerScribe One". "" if no problem yet.
- priority: "Urgent" only if they say STAT, urgent, ED/trauma, patient on the table/waiting, can't read at all, or everything is down. Else "Moderate".
- patient_info: "N/A" unless the caller mentions a patient or study. If they refer to "this study/patient/the one I have open", use the open study. If they name a patient, use what they said.
- modality: from the caller's words or the open study when they refer to it; else "Other".
- application: one of the enum values, ONLY from the caller's words. Mapping: dictation/voice recognition/reports -> PowerscribeOne; images/viewer/hanging protocols -> the viewer they name (Sectra or GE Viewpoint); worklist/orders/exam status -> Epic Radiant; outside CD/images -> Ambra Outside Image; breast MRI CAD -> DynaCAD; breast density -> Volpara; stroke/perfusion -> Rapid; mouse/keyboard/monitor/PC/Windows login/printer -> Physician Workstation Issue; asks for a call back -> Radiologist Requesting Call Back; described but fits nothing -> Other. "Unknown" if they haven't said enough to tell.
- more_information: any useful extra detail from the caller (error text, when it started, what they tried), else "".`;
}

async function extract(session) {
  const lines = session.transcript.map((t) => `${t.role === 'agent' ? 'Agent' : 'Caller'}: ${t.text}`).join('\n');
  const res = await llm().chat.completions.create({
    model: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o',
    messages: [
      { role: 'system', content: extractPrompt(session) },
      { role: 'user', content: lines },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'ticket_fields', strict: true, schema: EXTRACT_SCHEMA } },
    temperature: 0,
    max_tokens: 400,
  });
  return JSON.parse(res.choices[0].message.content);
}

// ---------- turn handling ----------
/**
 * Processes one caller utterance and returns what the agent should say next.
 * { say: string|null, events: [...], done: boolean } — say=null means stay silent (caller said nothing new).
 */
export async function nextTurn(session, utterance, mode) {
  const events = [];
  if (session.ticket) return { say: null, events, done: true };
  session.transcript.push({ role: 'caller', text: utterance });

  let x;
  try {
    x = await extract(session);
  } catch (err) {
    console.error('[extract]', err.message);
    return { say: 'Sorry, could you say that again?', events, done: false };
  }

  if (x.last_utterance === 'unintelligible') return { say: 'Sorry, could you say that again?', events, done: false };
  if (x.last_utterance === 'filler' && session.transcript.length > 2) return { say: null, events, done: false };

  // Identify the caller by name if caller ID didn't.
  let justIdentified = false;
  if (!session.caller && x.caller_name && x.caller_name !== session.lastLookupName) {
    session.lastLookupName = x.caller_name;
    const matches = lookupByName(x.caller_name);
    session.candidates = matches;
    events.push({ type: 'lookup', name: x.caller_name, matches: matches.map((m) => ({ name: m.name, workstation: m.workstation })) });
    if (matches.length === 1) {
      session.caller = matches[0];
      session.identifiedBy = 'name';
      session.draft.system_id = matches[0].workstation;
      justIdentified = true;
      events.push({ type: 'caller.identified', caller: session.caller });
    }
  }
  // A system ID the caller states (or a correction) wins over the lookup.
  if (x.system_id) session.draft.system_id = x.system_id.trim().toUpperCase().replace(/\s+/g, '-');

  const d = session.draft;
  Object.assign(d, {
    short_description: x.short_description.slice(0, 80),
    priority: x.priority,
    patient_info: x.patient_info || 'N/A',
    modality: x.modality,
    application: x.application === 'Unknown' ? '' : x.application,
    more_information: x.more_information || x.problem,
  });
  events.push({ type: 'ticket.draft', draft: { ...d } });

  const first = session.caller ? spokenName(session.caller.name) : '';

  if (!d.system_id) {
    if (session.candidates?.length > 1) {
      const names = session.candidates.slice(0, 3).map((m) => m.name.split(',').reverse().join(' ').trim());
      return { say: `Is that ${names.join(' or ')}?`, events, done: false };
    }
    return {
      say: x.caller_name ? "I couldn't find you on the dashboard. What's the system ID on your PC sticker?" : 'Who am I speaking with?',
      events,
      done: false,
    };
  }

  if (!x.problem) {
    return { say: justIdentified ? `Thanks ${first}, you're on ${d.system_id}. What's going on?` : "What's going on?", events, done: false };
  }

  if (!d.application && !session.askedApplication) {
    session.askedApplication = true;
    return { say: 'Which application is that, PowerScribe, Sectra, or Epic?', events, done: false };
  }

  // Everything required is known: save, then close.
  const ticket = saveTicket({
    ...d,
    application: d.application || 'Other',
    caller_name: session.caller?.name || x.caller_name || null,
    caller_phone: session.phone,
    identified_by: session.identifiedBy,
    system_id_on_dashboard: isWorkstationActive(d.system_id),
    call_duration_ms: Date.now() - session.startedAt,
  });
  session.ticket = ticket;
  session.draft = { ...d, application: ticket.application };
  events.push({ type: 'ticket.submitted', ticket });

  const lead = justIdentified ? `Thanks ${first}, logged for ${d.system_id}.` : mode === 'voice' ? "Got it, it's logged." : `Logged as ${ticket.number}.`;
  return { say: `${lead} Someone will follow up shortly.`, events, done: true };
}
