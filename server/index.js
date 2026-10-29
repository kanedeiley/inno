import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { directorySample, loadData, lookupByPhone } from './data.js';
import { createSession, getSession, publicSession } from './agent.js';
import { chatGreeting, handleChatTurn } from './chat.js';
import { attachRealtime } from './realtime.js';
import { listTickets } from './tickets.js';

loadData();

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    azureConfigured: Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY),
  });
});

// Caller-ID panel preview (no session created).
app.get('/api/lookup', (req, res) => res.json(lookupByPhone(req.query.phone)));

app.get('/api/directory', (_req, res) => res.json(directorySample()));

// Start a simulated call. Pre-call context (phone lookup) is resolved here, before the model says a word.
app.post('/api/session', (req, res) => {
  const session = createSession({ phone: req.body?.phone?.trim() || null });
  const greeting = req.body?.mode === 'chat' ? chatGreeting(session) : null;
  res.json({ session: publicSession(session), greeting });
});

app.post('/api/chat', async (req, res) => {
  const session = getSession(req.body?.sessionId);
  if (!session) return res.status(404).json({ error: 'Unknown session' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Empty message' });
  try {
    const { reply, events } = await handleChatTurn(session, message);
    res.json({ reply, events, session: publicSession(session) });
  } catch (err) {
    console.error('[chat]', err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/tickets', (_req, res) => res.json(listTickets().reverse()));

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve('dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = http.createServer(app);
attachRealtime(server);

const port = Number(process.env.PORT || 3001);
server.listen(port, () => console.log(`[server] http://localhost:${port}`));
