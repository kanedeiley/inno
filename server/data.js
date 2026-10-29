import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');

function readCsv(file) {
  const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
}

// Column lookups are case/space-insensitive so minor header differences in the real extracts don't break things.
function col(row, name) {
  const want = name.toLowerCase().replace(/\s+/g, '');
  const key = Object.keys(row).find((k) => k.toLowerCase().replace(/\s+/g, '') === want);
  return key ? String(row[key] ?? '').trim() : '';
}

const normWs = (s) => String(s || '').trim().toUpperCase();

export function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

export function isValidPhone(input) {
  const d = normalizePhone(input);
  return d.length === 10 || (d.length >= 4 && d.length <= 5); // full number or internal extension
}

let dashboard = [];
let dashboardByWs = new Map();
let phoneIndex = []; // { phone, pcName, location }

export function loadData() {
  dashboard = readCsv('Dashboard_table.csv').map((r) => ({
    role: col(r, 'Role'),
    account: col(r, 'Account'),
    session: col(r, 'Session'),
    workstation: normWs(col(r, 'Workstation')),
    site: col(r, 'Site'),
    accession: col(r, 'Accession'),
    procedure: col(r, 'Procedure'),
    patient: col(r, 'Patient'),
    attending: col(r, 'Attending'),
    lock: col(r, 'Lock'),
    lastAction: col(r, 'Last Action'),
  }));
  dashboardByWs = new Map();
  for (const row of dashboard) if (row.workstation && !dashboardByWs.has(row.workstation)) dashboardByWs.set(row.workstation, row);

  phoneIndex = [];
  for (const r of readCsv('Phone_extract_AI.csv')) {
    const pcName = normWs(col(r, 'PC Name'));
    // A cell may hold several numbers: "413-555-0122 / x40122"
    for (const part of col(r, 'Phone Numbers').split(/[,;/\n|]+/)) {
      const phone = normalizePhone(part);
      if (phone) phoneIndex.push({ phone, pcName, location: col(r, 'Location') });
    }
  }
  console.log(`[data] ${dashboard.length} dashboard rows, ${phoneIndex.length} phone entries`);
}

function callerFromRow(row, extra = {}) {
  return {
    name: row.account,
    role: row.role,
    workstation: row.workstation,
    site: row.site,
    study: row.accession
      ? { accession: row.accession, procedure: row.procedure, patient: row.patient, modality: inferModality(row.procedure) }
      : null,
    ...extra,
  };
}

/** Phone -> PC Name -> must be an active dashboard workstation. */
export function lookupByPhone(input) {
  const phone = normalizePhone(input);
  if (!isValidPhone(phone)) return { ok: false, reason: 'invalid_phone' };
  const hit = phoneIndex.find((p) => p.phone === phone || (p.phone.length <= 5 && phone.endsWith(p.phone)));
  if (!hit) return { ok: false, reason: 'phone_not_found' };
  const row = dashboardByWs.get(hit.pcName);
  if (!row) return { ok: false, reason: 'workstation_not_on_dashboard', workstation: hit.pcName };
  return { ok: true, caller: callerFromRow(row, { phone, location: hit.location }) };
}

/** Fuzzy name match against Account ("Patel, Anika", "Dr. Patel", "anika patel"). */
export function lookupByName(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/\b(dr|doctor|mr|mrs|ms|miss)\b\.?/g, ' ')
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const scored = dashboard
    .filter((r) => r.account && r.workstation)
    .map((r) => {
      const acctTokens = r.account.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      const score = tokens.filter((t) => acctTokens.some((a) => a === t || (t.length >= 4 && a.startsWith(t)))).length;
      return { r, score };
    })
    .filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score === best).map((x) => callerFromRow(x.r));
}

/** Sample of caller IDs for the demo panel, with whether each resolves to an active workstation. */
export function directorySample(limit = 6) {
  const seen = new Set();
  const unique = phoneIndex.filter((p) => p.phone.length === 10 && !seen.has(p.pcName) && seen.add(p.pcName));
  const active = unique.filter((p) => dashboardByWs.has(p.pcName)).slice(0, limit);
  const inactive = unique.find((p) => !dashboardByWs.has(p.pcName)); // shows the "ask for name" path
  return [...active, ...(inactive ? [inactive] : [])].map((p) => ({
    phone: p.phone,
    workstation: p.pcName,
    name: dashboardByWs.get(p.pcName)?.account || null,
  }));
}

export function isWorkstationActive(ws) {
  return dashboardByWs.has(normWs(ws));
}

export const MODALITIES = ['CT', 'IR', 'Mammo / Dexa', 'MRI', 'Nuclear Medicine', 'US', 'XR / Fluoro', 'Other'];
export const APPLICATIONS = [
  'Ambra Outside Image', 'DynaCAD', 'Epic Mammography', 'Epic Radiant', 'GE Viewpoint', 'Other',
  'Physician Workstation Issue', 'PowerscribeOne', 'Radiologist Requesting Call Back', 'Rapid', 'Sectra', 'Volpara',
];

export function inferModality(procedure) {
  const p = ` ${String(procedure || '').toUpperCase()} `;
  if (!p.trim()) return null;
  if (/\b(MAMMO|DEXA|DXA|TOMO|BREAST)\b/.test(p)) return 'Mammo / Dexa';
  if (/\b(MRI|MR|MRA)\b/.test(p)) return 'MRI';
  if (/\b(CT|CTA)\b/.test(p)) return 'CT';
  if (/\b(US|ULTRASOUND|DOPPLER|ECHO)\b/.test(p)) return 'US';
  if (/\b(NM|NUC|PET|SPECT)\b/.test(p)) return 'Nuclear Medicine';
  if (/\b(IR|INTERVENTIONAL|BIOPSY|DRAIN|EMBOLIZATION|ANGIO)\b/.test(p)) return 'IR';
  if (/\b(XR|X-RAY|DX|CR|FLUORO|ESOPHAGRAM)\b/.test(p)) return 'XR / Fluoro';
  return 'Other';
}
