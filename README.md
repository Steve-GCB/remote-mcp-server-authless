# GCB MCP notification channels

Worker: `gcb-mcp-test`. Endpoint: https://gcb-mcp-test.satoshi-yamashita.workers.dev/mcp

## Single source of truth

Edit only `config/slack-notice-channels.json` to add a destination. Keep `version: 1`; each channel requires `id`, `name` (without #), `lane` (`work`, `personal`, `finance`), and `description`.

`src/notice-config.ts` validates the JSON and derives the immutable IDs and tool description. The MCP enum and sender guard use the same ID array. Unknown destinations fail before Slack access. JSON syntax, strict fields, nonempty list/description, ID/name format and duplicate IDs/names are checked. The real OAuth/MCP integration test compares tools/list to the config. Slack tests use mocks only.

## Add one channel

1. Ensure the intended private channel already exists and the existing Bot is a member.
2. Add its entry to `config/slack-notice-channels.json` on a branch. Do not change the two existing Work IDs or purposes.
3. Run `npm install` then `npm run verify` (tests and Wrangler dry-run).
4. Merge into `main`. Existing Cloudflare Workers Builds watches `main` and runs `npm run deploy`, which reruns verification before deployment. Failed verification stops deployment and leaves the active version unchanged. No additional code edits or manual deploy are needed.
5. Check Cloudflare deployment status and exact commit/version; use an authenticated MCP client to run `tools/list`, comparing `send_slack_notice.inputSchema.properties.channel_id.enum` and description to the JSON. Do not call send tools for verification. Refresh the client's tool catalog/reconnect if it caches old definitions.

Use the pinned direct dependency versions in package.json. No new service, KV config store, GitHub Actions secrets, or OAuth scopes are required.

## Rollback

Before deployment record the active Cloudflare Version ID and corresponding Git commit. In Worker > Deployments, select the previous known-good version and roll it back to 100% traffic. Confirm the active version and authenticated tools/list; do not assume success from the click. Revert the offending Git change before the next main deployment so the faulty configuration is not redeployed. Never change OAuth/KV bindings or rotate secrets as part of a channel rollback.

Baseline recorded 2026-11-11: active version prefix `4fa3bd76`, source commit `0bc6ee76c1ded783371bd9771e3e97e770b0d5b5`. Current baseline tools: hello, send_slack, get_slack_replies, send_slack_notice (two Work channels). The modification changes only notice configuration and its description; authentication, idempotency, retry safety and thread handling remain intact. Bot display renaming is a separate operation and must not roll back working routing.

## Delivery safety

Persist a fresh UUID intent before an intended notice. On error/unknown delivery reconcile the visible AIOS notice marker using Slack before any retry. The existing isolate-local duplicate guard is not durable cross-run deduplication. Never use a send tool as a smoke test.
