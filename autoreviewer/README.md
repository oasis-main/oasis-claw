# autoreviewer bot

A Telegram bot for **fleet-wide** intents in an oasis-claw fleet. It is not an
openclaw agent. It runs no LLM. It shows cards to the operator, records the
operator's button presses, and keeps the peer-grant ledger.

Approval cards about one bot's own action do not come here. Those cards stay
in each bot's own chat, through openclaw's plugin approval path.

## What it does today (phase 1)

- **Peer grants.** A bot proposes a grant before it mails a peer: who may act,
  on which mail thread, for which topic and intent, for how long (at most
  24 h). The operator presses **Grant 1 h / 4 h / 24 h** or **Deny** on the
  card. Only the operator's Telegram account in the configured chat counts.
- **Commands.** `/grants` (live grants, each with a **Revoke** button),
  `/revoke GRANT-0001 [reason]`, `/status`, `/help`. A new command is one
  `bot.commands.register({ name, description, run })` call.

The reviewer does not read grants yet. That is phase 2.

## Trust model

| Rule | Where |
|---|---|
| The ledger has one writer: this service. Bots get it read-only. | `src/ledger.mjs` |
| The proposing bot is named from its source address, never from the request body. An unmapped address gets 403. | `src/clientmap.mjs`, `src/api.mjs` |
| No HTTP route decides, activates or revokes a grant. | `src/api.mjs` |
| A button press decides a grant only on that grant's own card, and only from the operator in the configured chat. | `src/bot.mjs` |
| A grant cannot join two bots that the mail relay keeps apart. | `src/main.mjs` (`canMail`) |
| Cards are plain text. Bot-written text appears under a label that names its author. | `src/cards.mjs` |

## Run

```bash
make autoreviewer-test
```

Setup and start: see the header of `docker-compose.autoreviewer.yml`, then
`make autoreviewer-map` and `make autoreviewer-up`.
