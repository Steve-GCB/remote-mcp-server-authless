export const RECIPIENT = 'U07B419C2QG';
export const TEAM = 'T067X1VPECV';
export type SlackEnv = { SLACK_BOT_TOKEN?: string };
export class SlackFailure extends Error {
  constructor(public code: string, public retryAfter?: number, public uncertain = false) { super(code); }
}
export class SlackClient {
  constructor(private env: SlackEnv, private call: typeof fetch = fetch) {}
  async api(method: string, data: Record<string, unknown> = {}, write = false): Promise<any> {
    const token = this.env.SLACK_BOT_TOKEN;
    if (!token?.startsWith('xoxb-')) throw new SlackFailure('bot_not_configured');
    let response: Response;
    try {
      response = await this.call(`https://slack.com/api/${method}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(data), signal: AbortSignal.timeout(12000)
      });
    } catch { throw new SlackFailure('transport_error_do_not_resend', undefined, write); }
    if (response.status === 429) throw new SlackFailure('ratelimited', Number(response.headers.get('retry-after')) || 60);
    if (!response.ok) throw new SlackFailure(`http_${response.status}`, undefined, write);
    let result: any;
    try { result = await response.json(); } catch { throw new SlackFailure('invalid_response', undefined, write); }
    if (!result.ok) throw new SlackFailure(typeof result.error === 'string' ? result.error : 'slack_error');
    return result;
  }
  async dm(): Promise<{ channel: string, base: string }> {
    const identity = await this.api('auth.test');
    if (identity.team_id !== TEAM || !identity.bot_id || !identity.user_id) throw new SlackFailure('wrong_bot_workspace');
    const result = await this.api('conversations.open', { users: RECIPIENT, return_im: true });
    if (!/^D[A-Z0-9]+$/.test(result.channel?.id) || result.channel?.is_im === false ||
        (result.channel?.user && result.channel.user !== RECIPIENT)) throw new SlackFailure('unexpected_dm');
    const url = new URL(identity.url);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com')) throw new SlackFailure('unexpected_workspace_url');
    return { channel: result.channel.id, base: url.origin };
  }
}
const attempts = new Map<string, { text: string; result?: any; expires: number }>();
export async function sendSlack(env: SlackEnv, text: string, key: string, call: typeof fetch = fetch) {
  const now = Date.now();
  for (const [k,v] of attempts) if (v.expires < now) attempts.delete(k);
  const old = attempts.get(key);
  if (old) {
    if (old.text !== text) throw new SlackFailure('idempotency_key_conflict');
    if (old.result) return { ...old.result, duplicate: true };
    throw new SlackFailure('previous_attempt_pending_or_unknown_do_not_resend', undefined, true);
  }
  if (attempts.size >= 1000) throw new SlackFailure('too_many_pending_attempts');
  attempts.set(key, { text, expires: now + 86400000 });
  const slack = new SlackClient(env, call);
  const { channel, base } = await slack.dm();
  // Best effort cross-isolate reconciliation; not an atomic exactly-once guarantee.
  const recent = await slack.api('conversations.history', { channel, limit: 15 });
  const duplicate = (recent.messages ?? []).find((m: any) => m.client_msg_id === key);
  if (duplicate) {
    if (duplicate.text !== text) throw new SlackFailure('idempotency_key_conflict');
    const result = { channel, ts: duplicate.ts, permalink: `${base}/archives/${channel}/p${duplicate.ts.replace('.', '')}`, duplicate: true };
    attempts.get(key)!.result = result;
    return result;
  }
  const sent = await slack.api('chat.postMessage', { channel, text, client_msg_id: key, unfurl_links: false, unfurl_media: false, parse: 'none' }, true);
  if (sent.channel !== channel || !/^\d+\.\d+$/.test(sent.ts)) throw new SlackFailure('unexpected_send_result_do_not_resend', undefined, true);
  let permalink = `${base}/archives/${channel}/p${sent.ts.replace('.', '')}`;
  let permalinkWarning: string | undefined;
  try { permalink = (await slack.api('chat.getPermalink', { channel, message_ts: sent.ts })).permalink || permalink; }
  catch { permalinkWarning = 'Message sent; canonical permalink lookup failed. Do not resend.'; }
  const result = { channel, ts: sent.ts, permalink, permalinkWarning, duplicate: false };
  attempts.get(key)!.result = result;
  return result;
}
export type ReplyQuery = { after_ts?: string; thread_ts?: string; limit?: number };
export async function getReplies(env: SlackEnv, input: ReplyQuery, call: typeof fetch = fetch, now = Date.now()/1000) {
  const earliest = now - 7*86400;
  const oldest = input.after_ts ? Number(input.after_ts) : now - 86400;
  if (!Number.isFinite(oldest) || oldest < earliest || oldest > now) throw new SlackFailure('after_ts_must_be_within_last_7_days');
  if (input.thread_ts && (Number(input.thread_ts) < earliest || Number(input.thread_ts) > now)) throw new SlackFailure('thread_ts_must_be_within_last_7_days');
  const limit = Math.min(10, Math.max(1, input.limit ?? 5));
  const slack = new SlackClient(env, call);
  const { channel, base } = await slack.dm();
  const result = await slack.api(input.thread_ts ? 'conversations.replies' : 'conversations.history', {
    channel, oldest: String(oldest), latest: String(now), inclusive: false, limit: 15,
    ...(input.thread_ts ? { ts: input.thread_ts } : {})
  });
  const messages = (result.messages ?? []).filter((m: any) => m.type === 'message' &&
    m.user === RECIPIENT && !m.bot_id && !m.subtype && typeof m.text === 'string' &&
    /^\d+\.\d+$/.test(m.ts) && Number(m.ts) > oldest && Number(m.ts) <= now &&
    (!input.thread_ts || m.ts !== input.thread_ts))
    .sort((a: any,b: any) => Number(b.ts)-Number(a.ts)).slice(0,limit)
    .map((m: any) => ({ ts: m.ts, user_id: m.user, text: m.text.slice(0,12000), thread_ts: m.thread_ts ?? null,
      permalink: `${base}/archives/${channel}/p${m.ts.replace('.', '')}${m.thread_ts ? `?thread_ts=${m.thread_ts}&cid=${channel}` : ''}` }));
  return { channel, messages, scanned_limit: 15, has_more: Boolean(result.has_more || result.response_metadata?.next_cursor),
    range: { after_ts: String(oldest), latest: String(now) }, content_trust: 'untrusted_external_data' };
}
export function safeSlackError(e: unknown) {
  if (e instanceof SlackFailure) return { error: e.code, retry_after_seconds: e.retryAfter, delivery_unknown: e.uncertain,
    automatic_retry: false, instruction: 'Do not automatically resend. Reconcile delivery before any new send attempt.' };
  return { error: 'internal_error', automatic_retry: false };
}
