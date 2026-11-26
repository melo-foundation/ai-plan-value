---
name: Quota weights submission
about: Submit a per-token-kind quota measurement from scripts/quota-probe.mjs
title: "[quota-weights] <plan> · <model> · <bar> · <client class>"
labels: quota-weights
---

<!-- Protocol and format: docs/QUOTA-WEIGHTS.md -->

**Session file** (attach the `.jsonl` from `scripts/quota-probe.mjs`, or link it):

**Raw bundle** (attach the `.raw.jsonl`, or link a gist):

| | |
|---|---|
| Plan | <!-- pro / max / ultra / team --> |
| Model | <!-- claude-opus-5-5 --> |
| Bar | <!-- 7d / 5h --> |
| Client class | <!-- interactive (tmux / guided) / sdk --> |
| Meter | <!-- statusline / rate_limit_event / manual / oauth --> |
| Claude Code version | <!-- claude --version --> |
| Probe command | <!-- the full `node scripts/quota-probe.mjs run …` line --> |

Output of `node scripts/fit-quota-weights.mjs --cell anthropic/<model>/<bar>/<class>`:

```
```

Controls:

- [ ] Account idle on every other device and surface (web, desktop, phone, scheduled and cloud agents)
- [ ] `idle_ticks` is 0 in the session file
- [ ] `CLAUDE_CODE_ENTRYPOINT` not set
- [ ] Started below 60% of the bar under test
- [ ] No prompts, replies, paths, account ids or email addresses in the attached files
