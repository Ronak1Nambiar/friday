// Telegram: a mission's check-ins on the phone. FRIDAY sends a question with buttons
// (Go / Cancel / …, from the question's own options) and waits for a tap or a typed
// reply, which becomes the "what to change" feedback. Only the user's own chat counts.
// The Bot API over fetch: no dependencies, nothing listens on this machine (long polling).
//
// Every text passes `guard` first: whatever it returns is sent instead (the cockpit
// replaces anything sealed or private with a plain "needs you in the terminal").
// Only one process may poll a bot at a time (a second gets HTTP 409); a poller that
// meets one waits and tries again.
import { parseChoices } from './asker.js';

export const TELEGRAM_API = 'https://api.telegram.org';
export const MAX_TEXT = 3500;

export function createTelegram({ token, chatId, base = TELEGRAM_API, fetchImpl = fetch, guard = (t) => t, pollTimeout = 50, retryMs = 5000 }) {
  let offset = null;
  let seq = 0;
  const call = async (method, body, signal) => {
    const res = await fetchImpl(`${base}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      const e = new Error(`telegram ${method}: ${j.description || res.status}`);
      e.status = res.status;
      throw e;
    }
    return j.result;
  };
  const clean = (text) => String(guard(String(text ?? '')) ?? '').slice(0, MAX_TEXT);

  // Updates left from before this question (old taps) are skipped, not answered.
  async function skipOld(signal) {
    if (offset !== null) return;
    const last = await call('getUpdates', { offset: -1, timeout: 0 }, signal);
    offset = last.length ? last[last.length - 1].update_id + 1 : 0;
  }

  return {
    send(text, { buttons = null } = {}) {
      const body = { chat_id: chatId, text: clean(text), disable_web_page_preview: true };
      if (buttons?.length) body.reply_markup = { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] };
      return call('sendMessage', body);
    },

    // Ask and wait. Resolves with the answer text, or null when `signal` aborts.
    async ask(question, { summary = '', signal = null } = {}) {
      const tag = `q${Date.now().toString(36)}${(seq++).toString(36)}`;
      const ch = parseChoices(question);
      const buttons = (ch?.options || []).slice(0, 4).map((o) => ({ text: o.label, data: `${tag}:${o.label}`.slice(0, 64) }));
      const text = [summary && clean(summary).slice(0, 800), clean(question), ch?.other ? `(or reply with: ${ch.other})` : ''].filter(Boolean).join('\n\n');
      try {
        await skipOld(signal);
        const sent = await this.send(text, { buttons });
        for (;;) {
          if (signal?.aborted) return null;
          let updates;
          try {
            updates = await call('getUpdates', { offset, timeout: pollTimeout, allowed_updates: ['message', 'callback_query'] }, signal);
          } catch (e) {
            if (signal?.aborted || e.name === 'AbortError') return null;
            await new Promise((r) => setTimeout(r, retryMs)); // 409 (another poller), network: wait, try again
            continue;
          }
          for (const u of updates) {
            offset = u.update_id + 1;
            const cb = u.callback_query;
            if (cb && String(cb.message?.chat?.id) === String(chatId) && String(cb.data || '').startsWith(`${tag}:`)) {
              call('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
              const answer = cb.data.slice(tag.length + 1);
              call('editMessageReplyMarkup', { chat_id: chatId, message_id: sent.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
              this.send(`✓ ${answer}`).catch(() => {});
              return answer;
            }
            const msg = u.message;
            // A typed reply counts only if it came after the question.
            if (msg && String(msg.chat?.id) === String(chatId) && typeof msg.text === 'string' && !msg.text.startsWith('/') && (msg.date || 0) >= (sent.date || 0)) return msg.text.trim();
          }
        }
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') return null;
        throw e;
      }
    },
  };
}

// Setup: the chat that sent the newest message to the bot (the user sends /start).
export async function findChat({ token, base = TELEGRAM_API, fetchImpl = fetch }) {
  const res = await fetchImpl(`${base}/bot${token}/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"timeout":0}' });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `HTTP ${res.status}`);
  const msgs = (j.result || []).map((u) => u.message).filter((m) => m?.chat?.id && m.chat.type === 'private');
  const m = msgs[msgs.length - 1];
  return m ? { chatId: m.chat.id, name: [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '' } : null;
}

// The bot's own name, which also checks the token.
export async function botName({ token, base = TELEGRAM_API, fetchImpl = fetch }) {
  const res = await fetchImpl(`${base}/bot${token}/getMe`, { method: 'POST' });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `HTTP ${res.status}`);
  return j.result.username;
}
