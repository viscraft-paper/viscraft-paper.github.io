/* VisCraftBench human study app — vanilla JS, fully client-side.
 * Flow: consent -> instructions (-> training questionnaire) -> trials -> done
 * (download results). ENABLE_QUIZ=false skips the questionnaire (testing round,
 * user 2026-11-20); the frozen instrument is kept for the real run.
 * Blinding: systems are never named; pair sides and trial order are randomized
 * with a seeded PRNG (per rater, reproducible). Results autosave to localStorage
 * after every response and are exported as results_<rater>.json.
 * Materials: ../materials/{pairs,checklists,stimuli,state_captions}.json (frozen).
 * Serving (2026-11-21): the claim response carries per-pair coverage
 * (ANSWERED preference trials); a fresh session deals its queue from the
 * least-covered pairs (deal.js: 27 preference trials, 9 per contrast, each
 * case at most once, + one break at the midpoint) and persists it as
 * state.manifest — resume always walks the saved manifest. No coverage in
 * the response (old backend / offline) -> the same deal with empty
 * coverage. No gold checks, no repeats (removed 2026-11-21).
 *
 * Question page (2026-11-20 meeting rework): specification at the top; small
 * click-to-zoom character references; videos judged against the SPECIFICATION
 * only (storyboard adherence dropped); each result's storyboard shown stacked
 * below the videos, bigger, with the planned state captioned above each panel
 * (composition by default, details behind a click); "?" tooltips on every
 * criterion; play-both / pause-both; full screen per video; "Save & stop" so a
 * rater can stop and resume anytime (every answer is recorded as it is given).
 */
"use strict";

const ENABLE_QUIZ = false;   // testing round: training questionnaire off (user 2026-11-20)

const PARAMS = new URLSearchParams(location.search);
const ACCESS_KEY = PARAMS.get("k") || "";   // unlisted-link token (legacy links)
const MAX_SESSIONS = 999;   // session-number cap R1..R999 — a runaway brake only;
                             // the store hands out the next free number (2026-11-21)
// Rater identity: legacy ?rater=R<n>&k=<tok> links still work; otherwise one
// shareable link and a login screen (unique name -> next free session number).
let RATER = PARAMS.get("rater") || "";
let RATER_NAME = PARAMS.get("name") || "";
let LS_KEY = RATER ? "vcstudy_v3_" + RATER : "";   // v3: 3-contrast 27-pref design (2026-11-21);
                                                   // v2 saves (2-contrast gold/repeat manifests) are stale

/* Criteria (2026-11-20 meeting): the videos are judged against the SPECIFICATION
 * only — storyboard adherence is dropped (a weak storyboard must not be winnable
 * by adherence). The storyboards get their own two questions in a separate
 * section, judged on the storyboard alone. [id, name, section, explanation] */
const CRITERIA = [
  ["identity", "Identity fidelity", "video",
   "Which video preserves the characters' identity better from start to end, and matches the character pictures better? Keep the characters distinct from each other. A change the specification asks for (a stain, a rolled sleeve) is not an identity change."],
  ["order", "Action and event order", "video",
   "Which video executes the requested actions more faithfully — all of them, in the requested order? Judge only what you can see against the specification; a beautiful video may still skip the requested action."],
  ["motion", "Motion plausibility and camera steadiness", "video",
   "Which video has smoother, more plausible motion? No morphing, no flicker, and nothing vanishing without a reason (leaving the view or passing behind something is fine). The camera should remain fixed — penalize any jitter or camera movement."],
  ["sb_coherence", "Coherent set of states", "sb",
   "Do the panels show the right moments of the specification, in a sensible order — six visual states that together tell the story?"],
  ["sb_consistency", "Visual consistency", "sb",
   "Across the panels, do the characters keep the same appearance (identity, clothing) and does the setting stay the same?"],
];

const QUIZ = [
  { q: "A video looks smooth and beautiful, but the requested action never happens. On 'Action and event order' you should:",
    a: ["Rate it high — it looks right", "Rate it low — judge visible content against the specification", "Mark it unratable"],
    ok: 1 },
  { q: "On a criterion, neither video can be judged at all (for example neither result resembles the specification). You should:",
    a: ["Pick the one that looks better", "Mark that criterion Unratable", "Rate both as Tie"],
    ok: 1 },
  { q: "Two videos look equally good on a criterion. You should:",
    a: ["Pick the first one", "Choose Tie", "Skip the question"],
    ok: 1 },
];

const state = {
  phase: "load",           // load | consent | quiz | trials | done
  materials: { pairs: null, checklists: null, stimuli: null, state_captions: null },
  manifest: null,          // THIS session's trial list (dealt or static; see enterStudy)
  trialIx: 0,
  responses: {},           // trialId -> response object
  times: {},               // trialId -> ms on trial
  quiz: null,
  started: null,
  lastEnter: null,
};

function prng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
};

/* ---------------- session store (Google Apps Script web app) -------------
   One row per session in a PRIVATE spreadsheet in the organizer's Google
   account (gas/Code.gs): rater | name | started | updated | done | state.
   The page calls it with plain fetch — there is NO credential in this file
   (the old GitHub PAT is gone; user 2026-11-20 "tiny backend instead").
   Session-number claims and the name→session lookup are atomic server-side (ScriptLock):
   the typed name is the resume credential, so "name taken -> welcome back" and
   resume from ANY device both work. There is NO endpoint that lists names; the
   full dump needs a separate key that lives only server-side + the organizer's
   notes (see analysis/fetch_claims.py). Requests use a simple Content-Type to
   avoid CORS preflight (Apps Script answers none).
   If the service is unreachable the page degrades to manual session-number entry.
   After the study: delete the Apps Script project + its spreadsheet. */
const GAS_URL = "https://script.google.com/macros/s/AKfycbxz8KEVy3qB5hZDPEeNAP9_mTr9PNaP0qVxqudNxFwkLr8hRKqrqsVXLat2EED_T34/exec";   // /exec URL from the Apps Script deploy
const claimsOn = () => /^https:\/\//.test(GAS_URL) && !GAS_URL.includes("__PASTE");

function gasPost(body, keepalive) {
  // text/plain: a "simple" request — no CORS preflight (Apps Script answers none)
  return fetch(GAS_URL, { method: "POST", keepalive: !!keepalive,
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body) });
}

async function claimJoin(name) {
  const r = await gasPost({ op: "claim", name });
  if (!r.ok) throw new Error("claim " + r.status);
  return r.json();          // { claimed } | { existing } | { error }
}

let claimTimer = null, claimBusy = false;
function scheduleClaim() {
  if (!claimsOn() || !RATER) return;
  clearTimeout(claimTimer);
  claimTimer = setTimeout(pushClaim, 8000);
}
async function pushClaim(opts = {}) {
  if (!claimsOn() || !RATER || claimBusy) return;
  claimBusy = true;
  try {
    await gasPost({ op: "save", rater: RATER, name: RATER_NAME,
      started: state.started, updated: Date.now(),
      done: state.phase === "done", state: localState() }, opts.keepalive);
  } catch { /* offline — localStorage holds everything; retried on next save */ }
  finally { claimBusy = false; }
}
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") pushClaim({ keepalive: true });
});

/* ---------------- persistence (localStorage + claims file) ---------------- */
function localState() {
  return { trialIx: state.trialIx, responses: state.responses, times: state.times,
    quiz: state.quiz, started: state.started, name: RATER_NAME,
    manifest: state.manifest || null, updated: Date.now() };
}
function pickNewer(a, b) {
  const t = (x) => (x && x.updated) || 0;
  return t(a) >= t(b) ? (a || b) : (b || a);   // local wins ties
}
function save() {
  localStorage.setItem(LS_KEY, JSON.stringify(localState()));
  scheduleClaim();
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
}
function savedFor(r) {
  try { return JSON.parse(localStorage.getItem("vcstudy_v3_" + r) || "null"); } catch { return null; }
}

function downloadResults() {
  const payload = {
    schema: "viscraftbench-human-study/v1",
    rater: RATER,
    rater_name: RATER_NAME || null,
    access_key_present: !!ACCESS_KEY,
    started: state.started,
    finished: new Date().toISOString(),
    quiz: state.quiz,
    exclusions: { quiz_pass: state.quiz ? state.quiz.score >= 3 : null },
    trial_order: trials().map(t => t.id),
    responses: Object.values(state.responses),
    trial_ms: state.times,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `results_${RATER}.json` });
  document.body.append(a); a.click(); a.remove();
  $("#status").textContent = "Results file saved. Please send it back as instructed.";
}

/* ---------------- screens ---------------- */
function renderConsent() {
  $("#screen").replaceChildren(
    el("div", { class: "card" },
      el("h1", {}, "Consent"),
      el("p", {}, "This study collects judgments of generated video clips. It is voluntary; you may withdraw at any time without consequence. No personal or sensitive data are collected. Your responses are recorded under a participant code together with the name you enter; files are kept private, the automatic online backup is a private record held by the researchers, and any released data are de-identified. The session takes about 30 minutes and includes one short break at the midpoint. Your progress is saved automatically: if you are interrupted, reopen this page and join again with your name to continue where you left off."),
      el("p", {}, "Purpose: we measure how people judge the execution of requested visual events in short generated clips, and how those judgments relate to automatic evaluation."),
      el("p", {}, "If you have questions, contact the study organizer (contact details were sent with your link)."),
      el("p", { class: "warn" }, "Please take only one session, and try to finish it in one sitting."),
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: () => go("quiz") }, "I agree, continue"),
      )));
}

function renderQuiz() {
  const form = el("div", {});
  const picks = [];
  (ENABLE_QUIZ ? QUIZ : []).forEach((item, i) => {
    picks.push(null);
    form.append(el("div", { class: "card" },
      el("h2", {}, `Q${i + 1}. ${item.q}`),
      ...item.a.map((opt, j) =>
        el("label", { class: "quizopt" },
          el("input", { type: "radio", name: `q${i}`, onchange: () => { picks[i] = j; btn.disabled = picks.includes(null); } }), opt))));
  });
  const btn = el("button", { class: "btn", ...(ENABLE_QUIZ ? { disabled: "disabled" } : {}), onclick: () => {
    if (!ENABLE_QUIZ) { state.quiz = null; save(); return go("trials"); }
    const score = picks.reduce((s, p, i) => s + (p === QUIZ[i].ok ? 1 : 0), 0);
    state.quiz = { picks, score };
    save();
    if (score >= QUIZ.length - 1) go("trials");
    else $("#screen").prepend(el("p", { class: "warn" },
      `Score ${score}/${QUIZ.length} — at least ${QUIZ.length - 1} correct answers are required to continue. Please re-read the instructions above and try again.`));
  } }, "Start the tasks");
  $("#screen").replaceChildren(
    el("div", { class: "card" },
      el("h1", {}, "Instructions"),
      el("p", {}, "Each task shows one specification and two results. Say which result does better."),
      el("ul", {},
        el("li", {}, el("b", {}, "Specification. "), "The intended scene and actions — the text both results were made from. Judge everything you see against it."),
        el("li", {}, el("b", {}, "Characters. "), "Small pictures labeled with the names from the specification. Click one to see it full size."),
        el("li", {}, el("b", {}, "Two videos. "), "Side by side. “Play both” starts them together and “Pause both” stops them together; ⤢ shows a video full screen."),
        el("li", {}, el("b", {}, "Two storyboards. "), "Below the videos, stacked. Storyboard 1 belongs to Video 1, Storyboard 2 to Video 2. The text above each panel describes the planned state — click “details” for the whole caption, click a panel to see it full size.")),
      el("p", {}, "You answer three questions about the videos and two about the storyboards. The questions are independent — one result can win one and lose another. Videos are judged against the specification only, not against the storyboards; the storyboard questions are about the storyboards alone."),
      el("h3", {}, "The three video questions"),
      ...CRITERIA.filter(([, , sec]) => sec === "video").map(([, name, , desc]) => el("p", {}, el("b", {}, `${name}. `), desc)),
      el("h3", {}, "The two storyboard questions"),
      ...CRITERIA.filter(([, , sec]) => sec === "sb").map(([, name, , desc]) => el("p", {}, el("b", {}, `${name}. `), desc)),
      el("h3", {}, "How to answer"),
      el("p", {}, el("b", {}, "Prefer 1 / Prefer 2: "), "that result is clearly better on this question. ",
        el("b", {}, "Tie: "), "you cannot tell them apart. ",
        el("b", {}, "Unratable: "), "the question cannot be judged at all (for example, neither video looks like the specification)."),
      el("h3", {}, "Three examples"),
      el("ul", {},
        el("li", {}, el("b", {}, "Behind a screen. "), "A character goes behind a screen and is supposed to come back out. Check that they do come back — and are still the same character."),
        el("li", {}, el("b", {}, "A small requested change. "), "Say the specification asks for one character's cuff to turn stained. Check that only that cuff changes, the change lasts, and the other character stays the same."),
        el("li", {}, el("b", {}, "A weak storyboard, a good video. "), "A video can follow the specification well even when its storyboard is poor — judge the videos against the specification, and judge the storyboards on their own."))),
    form, btn);
}

/* ---------------- trial renderers ---------------- */
function renderBreak(t) {
  // short rest at the midpoint; no response recorded (id kept out of results)
  $("#screen").replaceChildren(
    el("div", { class: "card" },
      el("h1", {}, "Short break"),
      el("p", {}, "You are about halfway through. Feel free to stretch or rest your eyes for a minute — this screen will wait."),
      el("p", { class: "muted" }, "When you are ready, continue. The remaining tasks are the same kind as before."),
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: next }, "Continue"),
        el("button", { class: "btn ghost", onclick: stopSession }, "Save & stop"))));
}
function mediaUrl(key, kind) {
  const s = state.materials.stimuli[kind === "strip" ? "strips" : "clips"][key];
  return s ? "../" + s.path : null;
}

/* small "?" button that toggles a help note (tooltips, 2026-11-20 meeting) */
function tipBtn(text) {
  const box = el("div", { class: "tipbox" }, text);
  return el("span", { class: "tipwrap" },
    el("button", { class: "tip", type: "button", "aria-label": "help", title: "help",
      onclick: (e) => { e.stopPropagation(); box.classList.toggle("open"); } }, "?"),
    box);
}

function specBlock(caseId) {
  const c = state.materials.checklists[caseId];
  const s = c.spec;
  const body = s.text != null ? s.text
    : `Scene: ${s.scene}\nCamera: ${s.camera}\nRoles: ${s.roles.join(", ")}\nInitial state: ${s.initial}\nActions (in order):\n${s.actions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}`;
  // refs: [{name, path}] — the name is the one the specification uses
  const refs = (c.refs || []).map(r => typeof r === "string" ? { name: "", src: "../" + r } : { name: r.name, src: "../" + r.path });
  const srcs = refs.map(r => r.src);
  return el("div", {},
    el("h3", { class: "withtip" }, "Specification ",
      tipBtn("The text both results were made from. Judge what you see against this.")),
    el("div", { class: "spec" }, body),
    el("h3", { class: "withtip" }, "Characters ",
      tipBtn("The people to look for, labeled with the names the specification uses. Click a picture to see it full size.")),
    el("div", { class: "refs" }, ...refs.map((r, i) =>
      el("figure", { class: "refcard" },
        el("img", { src: r.src, alt: r.name ? `character reference: ${r.name}` : "character reference",
          title: "Click to see full size",
          onclick: () => openLightbox(srcs, i, (j, n) => refs[j].name ? `${refs[j].name} — ${j + 1} / ${n}` : `${j + 1} / ${n}`) }),
        r.name ? el("figcaption", {}, r.name) : null))));
}

/* Full-size image viewer (character references, storyboard panels).
 * fmtLabel(i, n) formats the counter — defaults to "i+1 / n". */
function openLightbox(srcs, ix, fmtLabel) {
  const fmt = fmtLabel || ((i, n) => `${i + 1} / ${n}`);
  const img = el("img", { src: srcs[ix], alt: "enlarged view",
    title: "Click the image to toggle 100% size",
    onclick: (e) => { e.stopPropagation(); img.classList.toggle("full"); } });
  const stage = el("div", { class: "lb-stage" }, img);
  const count = el("span", {}, fmt(ix, srcs.length));
  const show = (i) => {
    ix = (i + srcs.length) % srcs.length;
    img.src = srcs[ix];
    img.classList.remove("full");
    count.textContent = fmt(ix, srcs.length);
  };
  const close = () => { document.removeEventListener("keydown", onKey); lb.remove(); };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(ix + 1);
    else if (e.key === "ArrowLeft") show(ix - 1);
  };
  const lb = el("div", { id: "lightbox", role: "dialog", "aria-label": "Full-size view",
      onclick: (e) => { if (e.target === lb) close(); } },
    el("button", { class: "btn ghost lb-close", onclick: close }, "Close (Esc)"),
    srcs.length > 1 ? el("button", { class: "btn lb-nav lb-prev", onclick: (e) => { e.stopPropagation(); show(ix - 1); } }, "←") : null,
    stage,
    srcs.length > 1 ? el("button", { class: "btn lb-nav lb-next", onclick: (e) => { e.stopPropagation(); show(ix + 1); } }, "→") : null,
    el("div", { class: "lb-count" }, count, el("span", { class: "lb-hint" }, " — click the image for 100% size")));
  document.addEventListener("keydown", onKey);
  document.body.append(lb);
}

function panelUrls(key) {
  const p = state.materials.stimuli.panels && state.materials.stimuli.panels[key];
  return p ? p.paths.map(x => "../" + x) : null;
}

function videoCol(label, src) {
  const vid = el("video", { src, controls: "controls", loop: "loop", playsinline: "playsinline", preload: "auto" });
  const root = el("div", { class: "vcol" },
    el("div", { class: "vlabel" }, label,
      el("button", { class: "btn ghost fsbtn", type: "button", title: "Full screen (full resolution)",
        onclick: () => {
          if (vid.requestFullscreen) vid.requestFullscreen().catch(() => {});
          else if (vid.webkitEnterFullscreen) vid.webkitEnterFullscreen();
        } }, "⤢")),
    vid);
  return { root, vid };
}

function renderPreference(t) {
  // sides[0] = Video 1 (left; its storyboard is Storyboard 1). Sides are
  // randomized per trial with a PRNG seeded by (rater, trial id) —
  // reproducible for a given session, different across sessions.
  const rng = prng(hashStr(RATER + "|" + t.id));
  const sides = rng() < 0.5 ? ["A", "B"] : ["B", "A"];

  // criteria per trial (2026-11-20 meeting): video questions judged against
  // the specification; storyboard questions only when storyboards are shown.
  // Every expected criterion is seeded as null so the SAVED response is
  // self-describing: the backend counts a pair as covered only when no null
  // is left (fully answered) — reserved-but-unanswered pairs never count.
  const critIds = t.criteria || CRITERIA.map(([cid]) => cid);

  const resp = state.responses[t.id] || (state.responses[t.id] = {
    id: t.id, type: t.type, case: t.case, contrast: t.contrast || null,
    side_map: { "Video 1": sides[0], "Video 2": sides[1] },
    criteria: Object.fromEntries(critIds.map((cid) => [cid, null])),
  });
  for (const cid of critIds) if (!(cid in resp.criteria)) resp.criteria[cid] = null;
  const hasSb = !!t.showStrips && critIds.some((c) => c.startsWith("sb_"));

  const mkTable = (section, head1, head2) => el("table", { class: "likert" },
    el("tr", {}, el("th", {}, "Question"), el("th", {}, head1), el("th", {}, "Tie"),
      el("th", {}, head2), el("th", {}, "Unratable")),
    ...CRITERIA.filter(([cid, , sec]) => critIds.includes(cid) && sec === section)
      .map(([cid, name, , desc]) => {
        const rowName = `c_${cid}`;
        const cells = ["prefer1", "tie", "prefer2", "unratable"].map((v) =>
          el("td", {}, el("input", { type: "radio", name: rowName, value: v,
            ...(resp.criteria[cid] === v ? { checked: "checked" } : {}),
            onchange: () => { resp.criteria[cid] = v; check(); save(); } })));
        return el("tr", {}, el("td", { class: "crit" }, name, " ", tipBtn(desc)), ...cells);
      }));

  const btn = el("button", { class: "btn", disabled: "disabled", onclick: next }, "Next");
  function check() { btn.disabled = !critIds.every((cid) => resp.criteria[cid]); }
  check();

  // videos — play/pause both together (2026-11-20 meeting)
  const v1 = videoCol("Video 1", mediaUrl(t.videos[sides[0]], "clip"));
  const v2 = videoCol("Video 2", mediaUrl(t.videos[sides[1]], "clip"));
  const vids = [v1.vid, v2.vid];
  const playBtn = el("button", { class: "btn", type: "button", onclick: () => {
    if (vids.some((v) => !v.paused)) vids.forEach((v) => v.pause());
    else vids.forEach((v) => v.play());
  } }, "▶ Play both");
  const syncLabel = () => {
    playBtn.textContent = vids.some((v) => !v.paused) ? "⏸ Pause both" : "▶ Play both";
  };
  vids.forEach((v) => { v.addEventListener("play", syncLabel); v.addEventListener("pause", syncLabel); });

  // storyboards — stacked, bigger, per-state captions above the panels
  const caps = hasSb ? state.materials.state_captions[t.case] : null;
  const storyboard = (n, key) => {
    const psrcs = panelUrls(key) || [];
    const cells = (caps || []).map((cap, i) => {
      const det = el("div", { class: "cap-det-text" }, [cap.scene, cap.composition, cap.details].filter(Boolean).join(" "));
      return el("div", { class: "sbcell" },
        el("div", { class: "sbcap" },
          el("div", { class: "cap-scene" }, cap.scene),
          el("button", { class: "cap-det", type: "button",
            onclick: () => det.classList.toggle("open") }, "details"),
          det),
        el("img", { class: "sbpanel", src: psrcs[i], alt: `Storyboard ${n}, panel ${i + 1}`,
          title: "Click to see full size",
          onclick: () => openLightbox(psrcs, i, (j, m) => `Panel ${j + 1} / ${m}`) }));
    });
    return el("div", { class: "sbblock" },
      el("div", { class: "vlabel" }, `Storyboard ${n} (Video ${n})`),
      el("div", { class: "sbrow" }, ...cells));
  };

  const parts = [
    el("div", { class: "card" }, specBlock(t.case)),
    el("div", { class: "card" },
      el("div", { class: "vidtools" },
        playBtn,
        el("button", { class: "btn ghost", type: "button", onclick: () => {
          vids.forEach((v) => { v.currentTime = 0; v.play(); });
        } }, "↺ Restart both")),
      el("div", { class: "videos" }, v1.root, v2.root)),
    el("div", { class: "card" },
      el("h2", {}, "Judgments — the videos"),
      mkTable("video", "Prefer Video 1", "Prefer Video 2")),
  ];
  if (hasSb) {
    parts.push(
      el("div", { class: "card" },
        el("h2", {}, "The storyboards"),
        el("p", { class: "muted" }, "Each storyboard belongs to the video with the same number. The text above a panel describes the planned state — “details” shows the whole caption, and clicking a panel shows it full size."),
        storyboard(1, t.videos[sides[0]]),
        storyboard(2, t.videos[sides[1]])),
      el("div", { class: "card" },
        el("h2", {}, "Judgments — the storyboards"),
        mkTable("sb", "Prefer storyboard 1", "Prefer storyboard 2")));
  }
  parts.push(el("div", { class: "row" },
    btn,
    el("button", { class: "btn ghost", type: "button", onclick: stopSession }, "Save & stop")));
  $("#screen").replaceChildren(...parts);
}

/* ---------------- flow ---------------- */
function trials() { return state.manifest || []; }

function renderTrial() {
  const ts = trials();
  if (state.trialIx >= ts.length) return go("done");
  const t = ts[state.trialIx];
  state.lastEnter = Date.now();
  $("#progress").textContent = `Item ${state.trialIx + 1} of ${ts.length}`;
  if (t.type === "preference") renderPreference(t);
  else if (t.type === "break") renderBreak(t);
  else $("#screen").replaceChildren(el("div", { class: "card" },
    el("h1", {}, "Session error"),
    el("p", {}, `Unknown item type “${t.type}” — please rejoin with your name to resume.`)));
}

function next() {
  const t = trials()[state.trialIx];
  state.times[t.id] = (state.times[t.id] || 0) + (Date.now() - state.lastEnter);
  state.trialIx += 1;
  save();
  renderTrial();
}

/* Stop anytime (2026-11-20 meeting): every answer is already recorded; the
 * rater can close the page and resume later (same name, any device). */
function stopSession() {
  const ts = trials();
  const t = ts[state.trialIx];
  if (t && state.lastEnter) {
    state.times[t.id] = (state.times[t.id] || 0) + (Date.now() - state.lastEnter);
    state.lastEnter = null;
  }
  save();
  pushClaim();
  $("#progress").textContent = "Saved";
  $("#screen").replaceChildren(el("div", { class: "card" },
    el("h1", {}, "Progress saved"),
    el("p", {}, t
      ? `You are at item ${state.trialIx + 1} of ${ts.length}. Everything so far is recorded — you can close this page now and come back later (rejoin with your name to continue where you left off).`
      : "Everything is recorded."),
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: renderTrial }, "Continue now"),
      el("button", { class: "btn ghost", onclick: () => location.reload() }, "Back to the start"))));
}

function renderDone() {
  $("#progress").textContent = "Complete";
  $("#screen").replaceChildren(
    el("div", { class: "card" },
      el("h1", {}, "Thank you — done"),
      el("p", {}, "Your results are saved automatically. Download a copy and send it back as instructed — if the download does not start, use the button below."),
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: downloadResults }, "Download results file"),
        el("button", { class: "btn ghost", onclick: downloadResults }, "Download again"))));
  downloadResults();
}

function go(phase) {
  state.phase = phase;
  if (phase === "consent") renderConsent();
  else if (phase === "quiz") renderQuiz();
  else if (phase === "trials") { state.started = state.started || new Date().toISOString(); save(); renderTrial(); }
  else if (phase === "done") { save(); pushClaim(); renderDone(); }
}

/* ---------------- login (one shared link; unique name -> next free session) ---------------- */
let REMOTE_STATE = null;   // claim-file state (cross-device resume), picked vs localStorage
let CLAIM_INFO = null;     // last claim response (carries per-pair coverage for the deal)

function nameMap() {
  try { return JSON.parse(localStorage.getItem("vcstudy_v3_names") || "{}"); } catch { return {}; }
}

function startSession(r, name, remoteState) {
  RATER = r;
  RATER_NAME = name;
  LS_KEY = "vcstudy_v3_" + RATER;
  REMOTE_STATE = remoteState || null;
  // name -> session map in localStorage is a same-device FAST PATH (works offline);
  // the store resolves names globally (its row is the source of truth)
  if (name) {
    const names = nameMap();
    names[name.toLowerCase()] = r;
    localStorage.setItem("vcstudy_v3_names", JSON.stringify(names));
    localStorage.setItem("vcstudy_v3_lastname", name);
  }
  if (!loadSaved()) save();   // mark the session early so rejoin finds it
  enterStudy();
}

function renderLogin() {
  const nameIn = el("input", { type: "text", class: "namein", maxlength: "60",
    placeholder: "Your name", value: localStorage.getItem("vcstudy_v3_lastname") || "" });
  const note = el("p", { class: "warn", hidden: "hidden" }, "");
  const status = el("p", { class: "muted" }, "");   // feedback line during Join (no idle status poll)
  const holder = el("div", {});
  const joinBtn = el("button", { class: "btn", onclick: tryJoin }, "Join the study");

  function warn(msg) { note.textContent = msg; note.hidden = false; }

  async function tryJoin() {
    const name = nameIn.value.trim();
    if (!name) { warn("Please enter your name first."); nameIn.focus(); return; }
    note.hidden = true;
    joinBtn.disabled = true;
    status.textContent = "Checking sessions…";
    try {
      // same-device fast path (works offline); the store resolves names globally
      const mine = nameMap()[name.toLowerCase()];
      if (mine) return showWelcomeBack(mine, name, pickNewer(savedFor(mine), null), null);
      if (!claimsOn()) throw new Error("no-store");
      const res = await claimJoin(name);
      if (res.error === "full") { warn("All sessions are taken — please contact the organizer."); return; }
      if (res.error) throw new Error(res.error);
      CLAIM_INFO = res;    // {claimed|existing, coverage?} — coverage feeds the deal
      if (res.existing) {
        // name already taken -> welcome back (cross-device: state comes from
        // the store and merges with any local save via pickNewer)
        const remote = res.existing.state || null;
        return showWelcomeBack(res.existing.rater, name,
          pickNewer(savedFor(res.existing.rater), remote), remote);
      }
      return startSession(res.claimed.rater, name, null);
    } catch (e) {
      status.textContent = "";
      manualPicker();
      warn("Could not reach the session service — enter the lowest free session number (ask in the group chat).");
    } finally { joinBtn.disabled = false; }
  }

  function showWelcomeBack(r, name, saved, remote) {
    status.textContent = "";
    holder.replaceChildren(el("div", {},
      el("h2", {}, `Welcome back, ${name}!`),
      el("p", {}, `Your session (${r}) is ${saved && saved.trialIx > 0 ? "in progress" : "ready"} — continue where you left off.`),
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: () => startSession(r, name, remote) }, "Continue"),
        el("button", { class: "btn ghost",
          onclick: () => { holder.replaceChildren(); nameIn.value = ""; nameIn.focus(); } },
          "Not you? Choose a different name"))));
  }

  function manualPicker() {
    // degraded mode (claims service off/unreachable): enter a session number
    // directly (1..999); localStorage marks show same-device progress
    const numIn = el("input", { type: "number", class: "namein", min: "1", max: String(MAX_SESSIONS),
      placeholder: "Session number" });
    const go2 = el("button", { class: "btn", onclick: () => {
      const n = parseInt(numIn.value, 10);
      if (!(n >= 1 && n <= MAX_SESSIONS)) { warn(`Enter a session number between 1 and ${MAX_SESSIONS}.`); numIn.focus(); return; }
      const nm = nameIn.value.trim();
      if (!nm) { warn("Please enter your name first."); nameIn.focus(); return; }
      startSession("R" + n, nm, null);
    } }, "Use this session");
    holder.replaceChildren(el("div", { class: "row" }, numIn, go2),
      el("p", { class: "muted" }, "Offline mode — your progress still saves on this device."));
  }

  $("#screen").replaceChildren(el("div", { class: "card" },
    el("h1", {}, "Join the study"),
    el("p", {}, "Everyone uses this same page. Two steps:"),
    el("ul", {},
      el("li", {}, el("b", {}, "Enter your name. "), "Pick something unique (like “koala”) — typing it again on any device brings you back to where you left off."),
      el("li", {}, el("b", {}, "Press Join. "))),
    el("div", { class: "row" }, nameIn, joinBtn), note, holder, status,
    el("p", { class: "muted" }, "Progress saves automatically. To take a break, close the page and rejoin with your name later.")));
}

/* ---------------- boot ---------------- */
async function boot() {
  if (RATER) return enterStudy();   // legacy ?rater=R<n> link
  renderLogin();
}

/* Deal this session's queue from the least-covered pairs (dynamic serving,
 * user 2026-11-21): the claim response carries per-pair coverage (ANSWERED
 * preference trials); deal.js builds the 27-trial session (9 per contrast,
 * each case at most once) + midpoint break around the least-covered pairs.
 * Templates (criteria, opaque media keys) come from the flat pairs pool, so
 * nothing new is served and blinding is unchanged. No coverage in the claim
 * response (old backend / offline / legacy link) -> the same deal with
 * empty coverage — one code path, no static fallback. */
function dealManifest_() {
  const pairIndex = VCDEAL.pairIndexFromPairs(state.materials.pairs);
  const keys = Object.keys(pairIndex);
  const cases = [...new Set(keys.map(k => k.split("|")[0]))];
  const contrasts = [...new Set(keys.map(k => k.split("|")[1]))].sort();
  return VCDEAL.dealSession({ rater: RATER,
    coverage: (CLAIM_INFO && CLAIM_INFO.coverage) || {},
    pairIndex, cases, contrasts });
}

async function enterStudy() {
  $("#screen").replaceChildren(el("p", { class: "muted" }, "Loading…"));
  const [pairs, chk, stu, caps] = await Promise.all(["pairs", "checklists", "stimuli", "state_captions"].map(n =>
    fetch(`../materials/${n}.json`).then(r => { if (!r.ok) throw new Error(n); return r.json(); })));
  state.materials = { pairs, checklists: chk, stimuli: stu, state_captions: caps };
  if (!window.VCDEAL) throw new Error("deal.js failed to load");
  const saved = pickNewer(loadSaved(), REMOTE_STATE);

  /* Session manifest: a resumed session ALWAYS walks its saved manifest
   * (never a re-deal — that would orphan already-given answers); a fresh
   * session deals from the claim's coverage (or empty coverage offline)
   * and persists the manifest immediately, so later claims count its
   * answered trials. A saved session without a manifest (claimed but died
   * before the first save completed) simply deals fresh — it has no
   * answered trials to orphan. */
  if (saved && Array.isArray(saved.manifest) && saved.manifest.length) {
    state.manifest = saved.manifest;
  } else {
    state.manifest = dealManifest_();
    save(); pushClaim();
  }

  if (saved && saved.trialIx > 0) {
    RATER_NAME = RATER_NAME || saved.name || "";
    Object.assign(state, { trialIx: saved.trialIx, responses: saved.responses, times: saved.times,
      quiz: saved.quiz, started: saved.started });
    if (state.trialIx >= trials().length) return go("done");
    return go("trials");
  }
  go("consent");
}
boot().catch(e => $("#screen").replaceChildren(el("div", { class: "card" },
  el("h1", {}, "Load error"), el("p", {}, String(e)))));
