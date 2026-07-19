# Banter

Harmless, AI-driven **ambient roleplay** for Foundry VTT. When two or more player
characters stand near each other and banter mode is on, they occasionally trade a
few short **spoken** quips — shown as chat bubbles over their tokens and mirrored
to the chat log as in-character speech.

Banter is grounded in each character's **biography**, the player's own
**persona / relationship notes**, the **scene's tone**, and whether you're **in
combat**. It's meant to be light, low-cost background flavor — not a scripted
scene.

## How it works

- Generation runs through **[Connection Manager](https://github.com/cjennison/connection-manager)**.
  Banter registers an `AI Banter` connection type that calls an Azure OpenAI-compatible
  proxy and returns the exchange as structured lines.
- The proximity/trigger loop runs only on the **active GM**. Bubbles are broadcast
  to every client, so all players watch the quips pop up in sequence.
- Every AI call's token usage is recorded so the GM can see an **estimated cost**,
  including a projected cost-per-hour of banter.

## Setup (GM)

1. Install & enable **Connection Manager** and **Banter**.
2. In Connection Manager (*Game Settings → Configure Settings → Connection Manager →
   Manage Connections*), add an **AI Banter** connection: set the API base
   (e.g. `/ai`), the shared secret (stored only in your browser), and the model
   (`gpt-5-mini` recommended for dialogue, `gpt-5-nano` for cheapest).
3. Open **Configure Settings → Banter → Banter Settings & Cost** and:
   - pick your AI Banter connection,
   - set radius, frequency, chaos, and combat behavior,
   - tick **Banter enabled** (or use the quick toggle described below).

### Quick on/off toggle

A **Toggle Banter** button (speech-bubbles icon) appears in the **Token controls**
on the left toolbar for the GM. Click it any time to pause/resume banter without
opening settings.

### Chaos level

A `1–10` slider controls how wild the banter gets: `1` is mild small talk, `10` is
absurd, over-the-top ribbing (always good-natured, never grim).

## Player setup (per character)

Open your character sheet and click the **Banter** button (speech-bubbles icon) in
the sheet's title bar. There you can set:

- **Banter persona / voice** — how your character speaks and jokes.
- **Feelings toward other characters** — a short note per other PC, so your
  character can treat each of them differently.

## Cost visibility

The **Banter Settings & Cost** window shows spend **this session** and **all time**,
average cost/tokens per banter, and both a **projected** and **observed**
cost-per-hour. Per-1M-token prices are editable (defaults reflect published
gpt-5-nano / gpt-5-mini rates). Banter is designed to be negligible in cost — a
typical exchange is a fraction of a cent.

## API

```js
const banter = game.modules.get("foundry-banter").api;
banter.triggerNow();        // force a banter among the nearest eligible cluster (GM)
banter.openSettings();      // open the GM settings/cost window
banter.openProfile(actor);  // open a character's banter profile
banter.costStats();         // return the current cost/usage stats object
```

## Requirements

- Foundry VTT v13–v14
- dnd5e system
- Connection Manager module
- An AI proxy exposing `POST /banter` (see the `foundry-ai-proxy` reference server)

## License

MIT
