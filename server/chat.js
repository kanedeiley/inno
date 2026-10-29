import { AzureOpenAI } from 'openai';
import { buildInstructions, chatTools, runTool, spokenName } from './agent.js';

let client;
function getClient() {
  client ??= new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_CHAT_API_VERSION || '2024-10-21',
    deployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o',
  });
  return client;
}

/** Greeting is deterministic so the chat opens instantly with no model round-trip. */
export function chatGreeting(session) {
  const text = session.caller
    ? `Hi ${spokenName(session.caller.name)}, Radiology IT. What's going on?`
    : 'Radiology IT, who am I speaking with?';
  session.chat.push({ role: 'assistant', content: text });
  return text;
}

export async function handleChatTurn(session, userText) {
  session.chat.push({ role: 'user', content: userText });
  const events = [];

  for (let i = 0; i < 4; i++) {
    const res = await getClient().chat.completions.create({
      model: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o',
      messages: [{ role: 'system', content: buildInstructions(session, 'chat') }, ...session.chat],
      tools: chatTools,
      temperature: 0.3,
      max_tokens: 300,
    });
    const msg = res.choices[0].message;

    if (!msg.tool_calls?.length) {
      session.chat.push({ role: 'assistant', content: msg.content || '' });
      return { reply: msg.content || '', events };
    }

    session.chat.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      const { output, events: ev } = runTool(session, call.function.name, call.function.arguments);
      events.push({ type: 'tool', name: call.function.name, args: call.function.arguments, output }, ...ev);
      session.chat.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  return { reply: 'Sorry, something went wrong on my end. Someone from IT will call you back.', events };
}
