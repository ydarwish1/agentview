# Installing Agent View — guide for coding agents

Follow these steps in order. Don't report success until step 5 passes.

## 1. Check the machine

```bash
node --version        # must be v22 or newer
ls ~/.claude/projects # Claude Code's transcript folder; it must exist
```

If `~/.claude/projects` is somewhere else on this machine, find the folder that holds Claude Code's `*.jsonl` session files. Use that path as `TRANSCRIPTS_DIR` below.

## 2. Start the server

There is nothing to install: no `npm install` and no build step.

```bash
cd <this repo>
PORT=5076 TRANSCRIPTS_DIR="$HOME/.claude/projects" node server.js
```

Expected output:

```
[agent-view] listening on http://127.0.0.1:5076 transcripts=true console=…
```

- `transcripts=false` means the process can't read `TRANSCRIPTS_DIR`. Fix the path or the file permissions.
- `console=false` is fine. With no status feed, an agent counts as active while its transcript was written in the last 15 minutes. The page legend then reads CONSOLE OFFLINE.

To keep the server running, use your normal process manager, such as systemd, pm2 or tmux.

## 3. Make yourself show up

There are six agent slots: `prime`, `nova`, `core`, `orion`, `echo` and `astra`. An agent appears when its Claude Code session was **started from a folder that ends in `agents/<id>`**.

```bash
mkdir -p ~/work/agents/nova     # pick a free id from the six
cd ~/work/agents/nova
claude                          # this session is now "Nova" on the map
```

**ASK your user** which slot each of their agents should take. Don't reuse a slot that is already in use: two sessions on one id show up as one agent.

To rename the slots or change how many there are, edit **both** of these to match:
- `server.js`: `const AGENTS = [...]`
- `index.html`: `AG_ORDER`, `AG_NAME`, `AG_SPR`, `SEED` and `FLEET_SPR`

## 4. Confirm the transcript is found

From any shell:

```bash
ls ~/.claude/projects | grep -e '-agents-'
```

You should see a folder ending in `-agents-<id>` for each agent you started. If one is missing, that session wasn't started from an `agents/<id>` folder. Restart it from the right folder.

## 5. Verify: read it, then look at it

**Read it.** Run one tool call in the agent's session (a `ls`, for example), then:

```bash
curl -s http://127.0.0.1:5076/api/health
curl -s http://127.0.0.1:5076/api/agents
```

- In `/api/health`, `transcripts` must be `true`.
- In `/api/agents`, find your agent's id. Its `tools` array must contain the tool you just ran.

An empty `tools` array means the transcript wasn't matched, or is more than 15 minutes old. Go back to step 4.

**Look at it.** Open **http://127.0.0.1:5076** in a browser, or take a screenshot with a headless browser if you have one. It should look like `docs/live.png`, and clicking an agent should look like `docs/card.png`. Check that:
- your agent's node has a name label
- the tools you just used hang off it as smaller nodes
- the tool in use right now glows orange
- clicking the agent opens a card with its model and harness

If the whole page is empty, check `/api/health` first. For a UI-only check that needs no live agents, click **DEMO** (top right). All six slots animate.

## 6. Report back

Tell your user:
- the URL
- which agent ids are showing
- whether the optional status feed (`console`) is connected

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page says `NO TRANSCRIPT ACCESS` | The server can't read the `.jsonl` files. Run it as a user who can. |
| An agent never appears | Its session wasn't started from `…/agents/<id>`. See step 4. |
| An agent is grey (idle) but working | Its transcript is more than 15 minutes old, or a status feed at `CONSOLE_URL` reports it as idle. |
| `PORT must be a whole number` | Set `PORT` to a number from 1 to 65535. |

The server always binds `127.0.0.1`. To reach it from another machine, use an SSH tunnel or a reverse proxy.
