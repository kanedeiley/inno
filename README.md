# Radiology IT Helpdesk POC

A caller reports a workstation problem by **voice** (Azure `gpt-realtime`) or **chat** (Azure `gpt-4o`). The assistant uses caller ID and the dashboard to work out who is calling and fills in the radiology incident form. It aims to log the issue in **under 15 seconds**.

## Run

```bash
cp .env.example .env     # fill in AZURE_OPENAI_ENDPOINT / KEY / deployment names
npm install
npm run dev              # client http://localhost:5173, server :3001
```

Use Chrome or Edge with a headset (the realtime voice API is sensitive to echo).

## How a call works

1. **Before the call:** pick or type a caller ID. `/api/lookup` maps phone → `PC Name` (Phone_extract_AI.csv) → active `Workstation` (Dashboard_table.csv). On a match, the caller, workstation, and open study (patient, accession, and modality inferred from Procedure) are injected into the prompt and prefill the ticket.
2. **Greeting:** if the caller is identified, the assistant says "Hi Anika, Radiology IT. What's going on?" Otherwise it asks for a name, calls `lookup_caller_by_name` (fuzzy match on Account), and confirms the workstation.
3. **Issue:** the model infers priority, modality, application, and patient info itself. It asks at most one follow-up question.
4. **`submit_ticket`:** the ticket is validated (80-character description, enum lookups) and saved to `data/tickets.json` (`GET /api/tickets`). Voice mode hangs up automatically after the closing line.

The header timer shows the time from the first word to the ticket being logged. It turns green at ≤ 15 s.

## Layout

| Path | What |
| --- | --- |
| `server/data.js` | CSV load, phone normalization (10-digit or extension), name matching, modality inference |
| `server/agent.js` | Shared prompt, tool schemas, tool runner and call sessions (used by both chat and voice) |
| `server/chat.js` | gpt-4o tool loop; the greeting is instant (no model call) |
| `server/realtime.js` | WebSocket proxy to Azure realtime; tools run server-side and the key never reaches the browser |
| `server/tickets.js` | JSON-file ticket store (replace with ServiceNow etc.) |
| `client/src/lib/voice.js` | Mic → PCM16 24 kHz → WebSocket → playback, with barge-in |

## Realtime API flavor

- `AZURE_OPENAI_REALTIME_API=ga` (default): `wss://<res>.openai.azure.com/openai/v1/realtime?model=<deployment>`, GA session shape.
- `AZURE_OPENAI_REALTIME_API=preview`: `/openai/realtime?api-version=…&deployment=…`, beta session shape (for `gpt-4o-realtime-preview`).
- `AZURE_OPENAI_REALTIME_URL` overrides the URL entirely.

The client handles both event-name sets (`response.output_audio.*` and `response.audio.*`).

## Data

`data/*.csv` contains **sample** rows with the real column headers. Drop in the real extracts with the same filenames. Columns are matched case- and space-insensitively.
