# AGENTS.md — agentlink

Full guidance for all three Argus repos lives in the Argus repo:
`the Argus repo (github.com/LKRCharon/argus) AGENTS.md` — read it before changing anything here.

Quick reference for this repo:

```bash
bun test && bun run typecheck
AGENTLINK_RELAY=wss://relay.limen.codes/ws bun run packages/daemon/src/index.ts watch
```

- Stack is TypeScript on Bun. Do not add another language, not even for
  throwaway edit scripts.
- `AGENTLINK_RELAY` selects the relay; the default is localhost and simply
  fails. A stale `watch` process keeps the relay channel slot, so the next one
  dies with "通道已满" — check `pgrep -f daemon/src/index.ts` first.
- Transcript formats are discovered by reading real files under
  `~/.qoder/projects` and `~/.codex/sessions`. Verify before assuming: past bugs
  include keying codex turn-done off a `turn_ended` event that does not exist,
  and dropping thinking / user prompts / tool results entirely.
- `PermissionRequest` hooks must answer with
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow|deny|ask"}}`.
  Other hook events return `{}` — a bridge observes, it never rubber-stamps
  local decisions.
