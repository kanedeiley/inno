import { greeting, nextTurn, recordAgent } from './agent.js';

/** Greeting is deterministic so the chat opens instantly with no model round-trip. */
export function chatGreeting(session) {
  const text = greeting(session);
  recordAgent(session, text);
  return text;
}

export async function handleChatTurn(session, userText) {
  const { say, events } = await nextTurn(session, userText, 'chat');
  // Silent turns (caller said "thanks") still need something in chat: repeat the open question.
  const reply = say ?? (session.ticket ? 'Anything else, just reach out.' : session.lastSay);
  recordAgent(session, reply);
  return { reply, events };
}
