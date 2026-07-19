/**
 * Banter — harmless ambient AI roleplay for Foundry VTT.
 *
 * When two or more player characters are near each other and banter mode is on,
 * the module occasionally has them trade a few short SPOKEN quips, shown as chat
 * bubbles over their tokens (and mirrored to the chat log as in-character speech).
 *
 * Design
 * ------
 * - Generation runs through **Connection Manager**: this module registers an
 *   `ai-banter` connection type whose handler POSTs to the AI proxy `/banter`
 *   endpoint and returns `{ lines, usage, model }`. The GM picks which connection
 *   Banter uses in its settings.
 * - The proximity/trigger loop runs ONLY on the active GM. Bubbles are broadcast
 *   to every client via core's `ChatBubbles#broadcast` (which emits the core
 *   `chatBubble` socket), so all players see the quips pop up in sequence.
 * - Context is grounded in each character's biography + player-authored persona
 *   and relationship notes, the scene tone/context, and combat state.
 * - Every AI call's token usage is logged so the GM can see an estimated
 *   Azure OpenAI cost, including a projected cost-per-hour of banter.
 */

const MID = "foundry-banter";
const CM_ID = "connection-manager";
const BANTER_TYPE = "ai-banter";

/* Default per-1M-token prices (USD). Editable in Banter settings. */
const DEFAULT_PRICING = {
  "gpt-5-nano": { in: 0.05, out: 0.40 },
  "gpt-5-mini": { in: 0.25, out: 2.00 }
};

const SETTING_DEFS = {
  enabled:        { scope: "world", type: Boolean, default: false },
  connectionId:   { scope: "world", type: String,  default: "" },
  radiusFeet:     { scope: "world", type: Number,  default: 10 },
  chaos:          { scope: "world", type: Number,  default: 4 },
  inCombat:       { scope: "world", type: Boolean, default: true },
  minLines:       { scope: "world", type: Number,  default: 2 },
  maxLines:       { scope: "world", type: Number,  default: 4 },
  maxParticipants:{ scope: "world", type: Number,  default: 4 },
  checkSeconds:   { scope: "world", type: Number,  default: 45 },
  chancePercent:  { scope: "world", type: Number,  default: 25 },
  cooldownSeconds:{ scope: "world", type: Number,  default: 120 },
  bubbleSeconds:  { scope: "world", type: Number,  default: 6 },
  mirrorToChat:   { scope: "world", type: Boolean, default: true },
  pricing:        { scope: "world", type: Object,  default: DEFAULT_PRICING },
  usage:          { scope: "world", type: Array,   default: [] }
};

const S = (key) => game.settings.get(MID, key);
const setS = (key, val) => game.settings.set(MID, key, val);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const cm = () => game.modules.get(CM_ID)?.api ?? null;
const isActiveGM = () => game.users?.activeGM?.id === game.user.id;

/* -------------------------------------------- */
/*  Cost tracking                               */
/* -------------------------------------------- */

let sessionStart = Date.now();

function priceFor(model) {
  const table = S("pricing") || DEFAULT_PRICING;
  return table[model] || DEFAULT_PRICING[model] || { in: 0, out: 0 };
}

async function recordUsage(usage, model) {
  if (!usage) return 0;
  const pin = Number(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0) || 0;
  const pout = Number(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? 0) || 0;
  const pr = priceFor(model);
  const cost = (pin / 1e6) * (pr.in || 0) + (pout / 1e6) * (pr.out || 0);
  const log = foundry.utils.duplicate(S("usage") || []);
  log.push({ t: Date.now(), model, pin, pout, cost });
  while (log.length > 1000) log.shift();
  await setS("usage", log);
  return cost;
}

function costStats() {
  const log = S("usage") || [];
  const money = (n) => `$${n.toFixed(n < 0.01 ? 6 : 4)}`;
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

  const all = { n: log.length, cost: sum(log, x => x.cost), pin: sum(log, x => x.pin), pout: sum(log, x => x.pout) };
  const session = log.filter(x => x.t >= sessionStart);
  const sess = { n: session.length, cost: sum(session, x => x.cost) };

  const avgCost = all.n ? all.cost / all.n : null;
  const avgTokens = all.n ? (all.pin + all.pout) / all.n : null;

  // Projected rate at current settings: banters/hour, bounded by the cooldown.
  const checkSeconds = Math.max(5, Number(S("checkSeconds")) || 45);
  const chance = Math.min(1, Math.max(0, (Number(S("chancePercent")) || 0) / 100));
  const cooldown = Math.max(1, Number(S("cooldownSeconds")) || 120);
  const perHourRaw = (3600 / checkSeconds) * chance;
  const perHourCap = 3600 / cooldown;
  const projBantersPerHour = Math.min(perHourRaw, perHourCap);
  const projCostPerHour = avgCost != null ? projBantersPerHour * avgCost : null;

  // Observed session rate.
  const hoursElapsed = Math.max((Date.now() - sessionStart) / 3.6e6, 1 / 60);
  const obsBantersPerHour = sess.n / hoursElapsed;
  const obsCostPerHour = sess.cost / hoursElapsed;

  return {
    money, all, sess, avgCost, avgTokens,
    projBantersPerHour, projCostPerHour,
    obsBantersPerHour, obsCostPerHour
  };
}

/* -------------------------------------------- */
/*  Proximity detection (GM)                    */
/* -------------------------------------------- */

function tokenCenter(t) {
  const c = t.center ?? { x: t.x, y: t.y };
  return { x: c.x, y: c.y };
}

function feetBetween(a, b) {
  try {
    const r = canvas.grid.measurePath([tokenCenter(a), tokenCenter(b)]);
    if (r && Number.isFinite(r.distance)) return r.distance;
  } catch (e) { /* fall through */ }
  const gs = canvas.grid?.size || 100;
  const gd = canvas.scene?.grid?.distance || 5;
  const px = Math.hypot(tokenCenter(a).x - tokenCenter(b).x, tokenCenter(a).y - tokenCenter(b).y);
  return (px / gs) * gd;
}

function eligibleTokens() {
  const toks = canvas?.tokens?.placeables ?? [];
  return toks.filter(t =>
    t.actor &&
    t.actor.type === "character" &&
    t.actor.hasPlayerOwner &&
    t.document?.hidden !== true &&
    !t.document?.isSecret);
}

/** Return the largest available cluster of >=2 distinct-actor PCs within radius. */
function pickCluster(radiusFeet, maxParticipants) {
  const toks = eligibleTokens();
  if (toks.length < 2) return null;

  const clusters = [];
  for (const seed of toks) {
    const group = [seed];
    for (const other of toks) {
      if (other === seed) continue;
      if (feetBetween(seed, other) <= radiusFeet) group.push(other);
    }
    // De-duplicate by actor (avoid two tokens of the same actor).
    const byActor = new Map();
    for (const t of group) if (!byActor.has(t.actor.id)) byActor.set(t.actor.id, t);
    if (byActor.size >= 2) clusters.push({ seed, tokens: [...byActor.values()] });
  }
  if (!clusters.length) return null;

  // Prefer the biggest cluster; break ties randomly.
  clusters.sort((a, b) => b.tokens.length - a.tokens.length || Math.random() - 0.5);
  let { seed, tokens } = clusters[0];
  if (tokens.length > maxParticipants) {
    tokens = tokens
      .sort((a, b) => feetBetween(seed, a) - feetBetween(seed, b))
      .slice(0, maxParticipants);
  }
  return tokens;
}

/* -------------------------------------------- */
/*  Banter generation + delivery                */
/* -------------------------------------------- */

let banterRunning = false;
let lastBanterAt = 0;

async function buildParticipants(tokens) {
  const api = cm();
  const parts = [];
  for (const tok of tokens) {
    const actor = tok.actor;
    let base = {};
    try { base = api ? await api.buildContext({ actorId: actor.id, sceneId: canvas.scene?.id }) : {}; }
    catch (e) { /* best effort */ }
    parts.push({
      actorId: actor.id,
      tokenId: tok.id,
      name: base.character || actor.name,
      bio: base.biography || null,
      health: base.health || null,
      conditions: Array.isArray(base.conditions) ? base.conditions : null,
      persona: actor.getFlag(MID, "persona") || null
    });
  }
  // Relationship notes toward the OTHER present participants.
  for (const p of parts) {
    const actor = game.actors.get(p.actorId);
    const relMap = actor?.getFlag(MID, "rel") || {};
    const feelings = {};
    for (const o of parts) {
      if (o.actorId === p.actorId) continue;
      const note = relMap[o.actorId];
      if (note) feelings[o.name] = note;
    }
    if (Object.keys(feelings).length) p.feelings = feelings;
  }
  return parts;
}

/** Send bubbles + optional chat mirror, one line at a time. */
async function deliverBanter(lines, parts) {
  const mirror = !!S("mirrorToChat");
  const gap = Math.max(1, Number(S("bubbleSeconds")) || 6) * 1000;
  const styleIC = CONST.CHAT_MESSAGE_STYLES?.IC ?? 2;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const p = parts.find(x => x.name.toLowerCase() === String(line.speaker).toLowerCase()) || parts[0];
    const tok = canvas.tokens.get(p.tokenId);
    try {
      // pan:false so banter never yanks players' cameras to the speaker.
      if (tok) await canvas.hud.bubbles.broadcast(tok.document, line.text, { cssClasses: ["banter-bubble"], pan: false });
    } catch (e) { console.warn(`${MID} | bubble failed`, e); }

    if (mirror) {
      const actor = game.actors.get(p.actorId);
      const speaker = ChatMessage.getSpeaker({ actor, token: tok?.document, scene: canvas.scene });
      speaker.alias = p.name; // use the character (actor) name, not the token's name
      await ChatMessage.create({
        style: styleIC,
        speaker,
        content: `<span class="banter-line">${esc(line.text)}</span>`,
        flags: { [MID]: { banter: true } }
      });
    }
    if (i < lines.length - 1) await sleep(gap);
  }
}

async function runBanter(tokens, { manual = false } = {}) {
  if (!isActiveGM() || banterRunning) return;
  const connId = S("connectionId");
  if (!connId) {
    if (manual) ui.notifications.warn("Banter: no AI connection selected (Configure Settings → Banter).");
    return;
  }
  const api = cm();
  if (!api) return;

  banterRunning = true;
  try {
    const parts = await buildParticipants(tokens);
    if (parts.length < 2) return;

    const ctx = {
      kind: "banter",
      sceneId: canvas.scene?.id,
      inCombat: !!(game.combat?.started),
      chaos: Number(S("chaos")) || 4,
      minLines: Number(S("minLines")) || 2,
      maxLines: Number(S("maxLines")) || 4,
      participants: parts.map(p => ({
        name: p.name, persona: p.persona, bio: p.bio,
        health: p.health, conditions: p.conditions, feelings: p.feelings
      }))
    };

    const result = await api.run(connId, ctx);
    const lines = Array.isArray(result?.lines) ? result.lines : [];
    if (result?.usage) await recordUsage(result.usage, result.model);
    if (!lines.length) {
      if (manual) ui.notifications.warn("Banter: the AI returned no lines.");
      return;
    }
    lastBanterAt = Date.now();
    await deliverBanter(lines, parts);
  } catch (e) {
    console.error(`${MID} | banter failed`, e);
    if (manual) ui.notifications.error("Banter failed — see console.");
  } finally {
    banterRunning = false;
  }
}

/* The periodic trigger loop (GM only). */
let loopTimer = null;
function startLoop() {
  if (loopTimer) clearInterval(loopTimer);
  const tick = async () => {
    if (!isActiveGM() || banterRunning) return;
    if (!S("enabled")) return;
    if (game.combat?.started && !S("inCombat")) return;
    if (Date.now() - lastBanterAt < (Number(S("cooldownSeconds")) || 120) * 1000) return;
    const cluster = pickCluster(Number(S("radiusFeet")) || 10, Number(S("maxParticipants")) || 4);
    if (!cluster) return;
    const chance = Math.min(1, Math.max(0, (Number(S("chancePercent")) || 0) / 100));
    if (Math.random() > chance) return;
    await runBanter(cluster);
  };
  const period = Math.max(5, Number(S("checkSeconds")) || 45) * 1000;
  loopTimer = setInterval(tick, period);
}

/** Force a banter now among the best current cluster (ignores chance/cooldown). */
async function triggerNow() {
  if (!isActiveGM()) return ui.notifications.warn("Only the active GM can trigger banter.");
  const cluster = pickCluster(Number(S("radiusFeet")) || 10, Number(S("maxParticipants")) || 4);
  if (!cluster) return ui.notifications.warn("Banter: no two player characters are within range on this scene.");
  await runBanter(cluster, { manual: true });
}

/* -------------------------------------------- */
/*  ai-banter Connection Manager type           */
/* -------------------------------------------- */

function registerBanterConnectionType() {
  const api = cm();
  if (!api?.registerType) return;
  api.registerType({
    type: BANTER_TYPE,
    label: "AI Banter",
    secretFields: ["secret"],
    fields: [
      { key: "apiBase", label: "API base URL", type: "text", default: "/ai", hint: "Path or URL of the AI proxy (same-origin recommended)." },
      { key: "secret", label: "Shared secret", type: "password", hint: "Sent as the x-fai-secret header. Stored only in this browser." },
      { key: "model", label: "Model", type: "select", default: "gpt-5-mini", options: ["gpt-5-mini", "gpt-5-nano"], hint: "gpt-5-mini gives more coherent dialogue; gpt-5-nano is cheaper." }
    ],
    handler: async (ctx, cfg) => {
      const base = String(cfg.apiBase || "/ai").replace(/\/+$/, "");
      if (!cfg.secret) {
        ui.notifications.warn("AI Banter connection has no secret set (edit it on the GM's browser).");
        return { lines: [] };
      }
      const body = { ...ctx };
      if (cfg.model) body.model = cfg.model;
      const res = await fetch(`${base}/banter`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fai-secret": cfg.secret },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        console.warn(`${MID} | banter proxy ${res.status}`, await res.text().catch(() => ""));
        return { lines: [] };
      }
      return await res.json();
    }
  });
}

/* -------------------------------------------- */
/*  Player-facing banter profile (per actor)    */
/* -------------------------------------------- */

async function openBanterProfile(actor) {
  if (!actor?.isOwner) return ui.notifications.warn("You don't own this character.");
  const others = game.actors.filter(a => a.id !== actor.id && a.type === "character" && a.hasPlayerOwner);
  const persona = actor.getFlag(MID, "persona") ?? "";
  const relMap = actor.getFlag(MID, "rel") ?? {};

  const rows = others.length
    ? others.map(o => `
        <div class="form-group stacked">
          <label>Toward ${esc(o.name)}</label>
          <textarea name="rel_${o.id}" rows="2" placeholder="How does ${esc(actor.name)} feel about ${esc(o.name)}? (warmth, rivalry, in-jokes, history)">${esc(relMap[o.id] ?? "")}</textarea>
        </div>`).join("")
    : `<p class="notes">No other player characters exist yet to relate to.</p>`;

  const content = `
    <div class="banter-profile">
      <p class="notes">Shape how <strong>${esc(actor.name)}</strong> banters. This flavors the ambient quips they trade when standing near other characters.</p>
      <div class="form-group stacked">
        <label>Banter persona / voice</label>
        <textarea name="persona" rows="3" placeholder="e.g. Terse and dry; clipped sentences; secretly sentimental; hates small talk.">${esc(persona)}</textarea>
      </div>
      <hr>
      <h3><i class="fa-solid fa-people-arrows"></i> Feelings toward other characters</h3>
      ${rows}
    </div>`;

  const res = await foundry.applications.api.DialogV2.wait({
    window: { title: `Banter — ${actor.name}`, icon: "fa-solid fa-comments" },
    position: { width: 520 },
    content,
    buttons: [
      {
        action: "save", label: "Save", icon: "fa-solid fa-floppy-disk", default: true,
        callback: (event, button) => {
          const f = button.form.elements;
          const out = { persona: f.persona?.value ?? "" };
          for (const o of others) { const el = f[`rel_${o.id}`]; if (el) out[o.id] = el.value; }
          return out;
        }
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
    ],
    rejectClose: false
  }).catch(() => null);

  if (!res) return;
  await actor.setFlag(MID, "persona", (res.persona ?? "").trim());
  const rel = {};
  for (const o of others) { const v = (res[o.id] ?? "").trim(); if (v) rel[o.id] = v; }
  await actor.setFlag(MID, "rel", rel);
  ui.notifications.info("Banter profile saved.");
}

/* -------------------------------------------- */
/*  GM settings + cost report app               */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

class BanterSettingsApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "foundry-banter-settings",
    tag: "div",
    window: { title: "Banter Settings", icon: "fa-solid fa-comments", resizable: true },
    position: { width: 560, height: "auto" }
  };

  _connectionOptions() {
    const conns = (cm()?.getConnections?.() ?? []).filter(c => c.type === BANTER_TYPE);
    const sel = S("connectionId");
    if (!conns.length) return `<option value="">— no AI Banter connections —</option>`;
    return [`<option value="">— none —</option>`]
      .concat(conns.map(c => `<option value="${esc(c.id)}" ${c.id === sel ? "selected" : ""}>${esc(c.name)}</option>`))
      .join("");
  }

  _costHTML() {
    const st = costStats();
    const m = st.money;
    return `
      <fieldset class="banter-cost">
        <legend><i class="fa-solid fa-coins"></i> Estimated Azure OpenAI cost</legend>
        <div class="banter-cost-grid">
          <div><span class="k">This session</span><span class="v">${m(st.sess.cost)} <em>(${st.sess.n} banters)</em></span></div>
          <div><span class="k">All time</span><span class="v">${m(st.all.cost)} <em>(${st.all.n} banters)</em></span></div>
          <div><span class="k">Avg / banter</span><span class="v">${st.avgCost != null ? m(st.avgCost) : "—"}${st.avgTokens != null ? ` <em>(~${Math.round(st.avgTokens)} tok)</em>` : ""}</span></div>
          <div><span class="k">Projected / hour</span><span class="v">${st.projCostPerHour != null ? m(st.projCostPerHour) : "—"} <em>(~${st.projBantersPerHour.toFixed(1)}/hr)</em></span></div>
          <div><span class="k">Observed / hour</span><span class="v">${m(st.obsCostPerHour)} <em>(~${st.obsBantersPerHour.toFixed(1)}/hr this session)</em></span></div>
        </div>
        <p class="hint">"Projected" uses your frequency settings × average observed cost per banter. Rates are configurable below.</p>
        <button type="button" data-b-reset><i class="fa-solid fa-trash"></i> Reset cost data</button>
      </fieldset>`;
  }

  async _renderHTML() {
    const pr = S("pricing") || DEFAULT_PRICING;
    const nano = pr["gpt-5-nano"] || DEFAULT_PRICING["gpt-5-nano"];
    const mini = pr["gpt-5-mini"] || DEFAULT_PRICING["gpt-5-mini"];
    const num = (name, val, attrs = "") => `<input type="number" name="${name}" value="${val}" ${attrs}>`;
    const chk = (name, on) => `<input type="checkbox" name="${name}" ${on ? "checked" : ""}>`;

    return `
      <form class="banter-settings">
        ${this._costHTML()}

        <fieldset>
          <legend><i class="fa-solid fa-plug"></i> Generation</legend>
          <div class="form-group"><label>AI connection</label><select name="connectionId">${this._connectionOptions()}</select>
            <p class="hint">Create an "AI Banter" connection in Connection Manager first.</p></div>
          <div class="form-group"><label class="checkbox">${chk("enabled", S("enabled"))} Banter enabled</label></div>
          <div class="form-group"><label>Chaos (1–10) <span class="b-chaos-val">${S("chaos")}</span></label>
            <input type="range" min="1" max="10" step="1" name="chaos" value="${S("chaos")}" class="b-chaos">
            <p class="hint">1 = mild small talk, 10 = wild, absurd ribbing (still good-natured).</p></div>
          <div class="form-group"><label class="checkbox">${chk("inCombat", S("inCombat"))} Allow banter during combat</label></div>
        </fieldset>

        <fieldset>
          <legend><i class="fa-solid fa-ruler"></i> Proximity &amp; frequency</legend>
          <div class="b-two">
            <div class="form-group"><label>Radius (feet)</label>${num("radiusFeet", S("radiusFeet"), 'min="5" step="5"')}</div>
            <div class="form-group"><label>Max participants</label>${num("maxParticipants", S("maxParticipants"), 'min="2" max="5" step="1"')}</div>
          </div>
          <div class="b-two">
            <div class="form-group"><label>Check every (sec)</label>${num("checkSeconds", S("checkSeconds"), 'min="5" step="5"')}</div>
            <div class="form-group"><label>Chance per check (%)</label>${num("chancePercent", S("chancePercent"), 'min="0" max="100" step="5"')}</div>
          </div>
          <div class="b-two">
            <div class="form-group"><label>Cooldown (sec)</label>${num("cooldownSeconds", S("cooldownSeconds"), 'min="10" step="10"')}</div>
            <div class="form-group"><label>Bubble gap (sec)</label>${num("bubbleSeconds", S("bubbleSeconds"), 'min="1" step="1"')}</div>
          </div>
          <div class="b-two">
            <div class="form-group"><label>Min lines</label>${num("minLines", S("minLines"), 'min="2" max="5" step="1"')}</div>
            <div class="form-group"><label>Max lines</label>${num("maxLines", S("maxLines"), 'min="2" max="5" step="1"')}</div>
          </div>
          <div class="form-group"><label class="checkbox">${chk("mirrorToChat", S("mirrorToChat"))} Mirror lines to the chat log</label></div>
        </fieldset>

        <fieldset>
          <legend><i class="fa-solid fa-tags"></i> Pricing (USD per 1M tokens)</legend>
          <div class="b-two">
            <div class="form-group"><label>gpt-5-nano input</label>${num("price_nano_in", nano.in, 'step="0.01" min="0"')}</div>
            <div class="form-group"><label>gpt-5-nano output</label>${num("price_nano_out", nano.out, 'step="0.01" min="0"')}</div>
          </div>
          <div class="b-two">
            <div class="form-group"><label>gpt-5-mini input</label>${num("price_mini_in", mini.in, 'step="0.01" min="0"')}</div>
            <div class="form-group"><label>gpt-5-mini output</label>${num("price_mini_out", mini.out, 'step="0.01" min="0"')}</div>
          </div>
        </fieldset>

        <footer class="b-footer">
          <button type="button" data-b-trigger><i class="fa-solid fa-comment-dots"></i> Trigger banter now</button>
          <button type="button" data-b-save><i class="fa-solid fa-floppy-disk"></i> Save</button>
        </footer>
      </form>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  _onRender() {
    const root = this.element;
    const range = root.querySelector(".b-chaos");
    const out = root.querySelector(".b-chaos-val");
    range?.addEventListener("input", () => { out.textContent = range.value; });

    root.querySelector("[data-b-reset]")?.addEventListener("click", async () => {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Reset cost data" }, content: "<p>Clear all recorded banter usage and cost history?</p>"
      }).catch(() => false);
      if (ok) { sessionStart = Date.now(); await setS("usage", []); this.render(); }
    });

    root.querySelector("[data-b-trigger]")?.addEventListener("click", () => triggerNow());

    root.querySelector("[data-b-save]")?.addEventListener("click", async () => {
      const f = this.element.querySelector("form").elements;
      const numv = (n, d) => { const v = Number(f[n]?.value); return Number.isFinite(v) ? v : d; };
      await setS("connectionId", f.connectionId?.value ?? "");
      await setS("enabled", !!f.enabled?.checked);
      await setS("inCombat", !!f.inCombat?.checked);
      await setS("mirrorToChat", !!f.mirrorToChat?.checked);
      await setS("chaos", Math.min(10, Math.max(1, numv("chaos", 4))));
      await setS("radiusFeet", numv("radiusFeet", 10));
      await setS("maxParticipants", Math.min(5, Math.max(2, numv("maxParticipants", 4))));
      await setS("checkSeconds", numv("checkSeconds", 45));
      await setS("chancePercent", Math.min(100, Math.max(0, numv("chancePercent", 25))));
      await setS("cooldownSeconds", numv("cooldownSeconds", 120));
      await setS("bubbleSeconds", numv("bubbleSeconds", 6));
      await setS("minLines", Math.min(5, Math.max(2, numv("minLines", 2))));
      await setS("maxLines", Math.min(5, Math.max(2, numv("maxLines", 4))));
      await setS("pricing", {
        "gpt-5-nano": { in: numv("price_nano_in", 0.05), out: numv("price_nano_out", 0.40) },
        "gpt-5-mini": { in: numv("price_mini_in", 0.25), out: numv("price_mini_out", 2.00) }
      });
      ui.notifications.info("Banter settings saved.");
      startLoop();
      ui.controls?.render?.();
      this.render();
    });
  }
}

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

Hooks.once("init", () => {
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    game.settings.register(MID, key, { scope: def.scope, config: false, type: def.type, default: def.default });
  }
  game.settings.registerMenu(MID, "settings", {
    name: "Banter Settings",
    label: "Banter Settings & Cost",
    hint: "Enable banter, tune proximity/frequency/chaos, and view estimated AI cost.",
    icon: "fa-solid fa-comments",
    type: BanterSettingsApp,
    restricted: true
  });
});

Hooks.once("setup", () => {
  // Connection Manager exposes its API at setup; register our type in ready.
});

Hooks.once("ready", () => {
  sessionStart = Date.now();
  registerBanterConnectionType();
  const mod = game.modules.get(MID);
  if (mod) mod.api = { triggerNow, openSettings: () => new BanterSettingsApp().render(true), openProfile: openBanterProfile, costStats };
  if (isActiveGM()) startLoop();
  console.log(`${MID} | ready`);
});

/* Quick GM on/off toggle in the token scene controls. */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools.banter = {
    name: "banter",
    title: "Toggle Banter",
    icon: "fa-solid fa-comments",
    toggle: true,
    active: !!S("enabled"),
    order: 900,
    onChange: (event, active) => {
      setS("enabled", active);
      ui.notifications.info(`Banter ${active ? "enabled" : "disabled"}.`);
    }
  };
});

/* Add a "Banter" button to the character sheet header for owners. */
Hooks.on("renderActorSheetV2", (app, html) => {
  const actor = app?.document;
  if (!actor || actor.type !== "character" || !actor.isOwner) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.querySelector(".window-header");
  if (!header || header.querySelector(".banter-profile-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control icon fa-solid fa-comments banter-profile-btn";
  btn.dataset.tooltip = "Banter";
  btn.setAttribute("aria-label", "Banter");
  btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openBanterProfile(actor); });
  const firstControl = header.querySelector(".header-control");
  if (firstControl) firstControl.before(btn); else header.appendChild(btn);
});
