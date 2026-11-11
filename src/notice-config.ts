import { z } from 'zod';
import rawConfig from '../config/slack-notice-channels.json';

export const noticeConfigSchema = z.object({
  version: z.literal(1),
  channels: z.array(z.object({
    id: z.string().regex(/^C[A-Z0-9]{8,}$/),
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    lane: z.enum(['work', 'personal', 'finance']),
    description: z.string().trim().min(1).max(200)
  }).strict()).min(1)
}).strict().superRefine((config, ctx) => {
  for (const field of ['id', 'name'] as const) {
    const values = config.channels.map(channel => channel[field]);
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'Duplicate channel ' + field });
  }
});
export function buildNoticeConfig(value: unknown) {
  const config = noticeConfigSchema.parse(value);
  const channels = Object.freeze(config.channels.map(channel => Object.freeze(channel)));
  const ids = Object.freeze(channels.map(channel => channel.id)) as readonly [string, ...string[]];
  const description = 'Send a Slack Bot notice only to configured owner-private notification channels: ' +
    channels.map(channel => '#' + channel.name + ' (' + channel.id + ', ' + channel.lane + '): ' + channel.description).join('; ') +
    '. Optional thread_ts appends to the existing semantic-work thread. Persist a fresh UUID send intent before calling. On any error or unknown delivery, reconcile the AIOS notice marker with the standard Slack plugin; never blindly retry. Read owner replies using the Slack plugin, not this tool.';
  return Object.freeze({ version: config.version, channels, ids, description });
}
export const NOTICE_CONFIG = buildNoticeConfig(rawConfig);
export const NOTICE_CHANNELS = NOTICE_CONFIG.ids;
export const NOTICE_DESCRIPTION = NOTICE_CONFIG.description;
