import fs from 'node:fs';
import path from 'node:path';

// POC persistence: a JSON file. Swap saveTicket() for a ServiceNow/Ivanti call later.
const FILE = path.resolve(process.env.DATA_DIR || 'data', 'tickets.json');

export function listTickets() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function saveTicket(fields) {
  const tickets = listTickets();
  const next = 1000001 + tickets.length;
  const ticket = { number: `INC${next}`, created_at: new Date().toISOString(), ...fields };
  tickets.push(ticket);
  fs.writeFileSync(FILE, JSON.stringify(tickets, null, 2));
  return ticket;
}
