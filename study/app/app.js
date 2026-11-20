/* VisCraftBench human study app — vanilla JS, fully client-side.
 * Flow: consent -> instructions (-> training questionnaire) -> trials -> done
 * (download results). ENABLE_QUIZ=false skips the questionnaire (testing round,
 * user 2026-11-20); the frozen instrument is kept for the real run.
 * Blinding: systems are never named; pair sides and trial order are randomized
 * with a seeded PRNG (per rater, reproducible). Results autosave to localStorage
 * after every response and are exported as results_<rater>.json.
 * Materials: ../materials/{assignment,checklists,stimuli}.json (frozen).
 */
"use strict";

const ENABLE_QUIZ = false;   // testing round: training questionnaire off (user 2026-11-20)

const PARAMS = new URLSearchParams(location.search);
const RATER = PARAMS.get("rater") || "";
const ACCESS_KEY = PARAMS.get("k") || "";   // unlisted-link token (anti-indexing)
const LS_KEY = "vcstudy_v2_" + RATER;   // v2: 10-rater full-coverage design (2026-11-20)

const CRITERIA = [
  ["identity",   "Identity fidelity",
   "Are the characters the same people from start to end, and the same as the character pictures? Keep the two characters distinct from each other. A change the specification asks for (a stain, a rolled sleeve) is not an identity change."],
  ["order",      "Action and event order",
   "Are all the requested actions done, in the requested order? Judge only what you can see against the specification — a beautiful video may still skip the requested action."],
  ["adherence",  "Storyboard adherence",
   "Does the video match the storyboard shown with it — who and what is where at each panel time, and the staging? Every case is one continuous shot with a fixed camera, so a cut inside the video is a violation here, even if it hides nothing."],
  ["motion",     "Motion plausibility",
   "Does the movement look real and steady? No morphing, no flicker, and nothing vanishing without a reason (leaving the view or passing behind something is fine)."],
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
  materials: { assignment: null, checklists: null, stimuli: null },
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

/* ---------------- persistence ---------------- */
function save() {
  localStorage.setItem(LS_KEY, JSON.stringify({
    trialIx: state.trialIx, responses: state.responses, times: state.times,
    quiz: state.quiz, started: state.started,
  }));
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
}

function downloadResults() {
  const payload = {
    schema: "viscraftbench-human-study/v1",
    rater: RATER,
    access_key_present: !!ACCESS_KEY,
    started: state.started,
    finished: new Date().toISOString(),
    quiz: state.quiz,
    exclusions: { quiz_pass: state.quiz ? state.quiz.score >= 3 : null },
    trial_order: state.materials.assignment ? state.materials.assignment[RATER].map(t => t.id) : [],
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
      el("p", {}, "This study collects judgments of generated video clips. It is voluntary; you may withdraw at any time without consequence. No personal or sensitive data are collected. Your responses are recorded under a code, are anonymized, and any released data are de-identified. The session takes about 45–60 minutes and includes one short break at the midpoint. Your progress is saved automatically: if you are interrupted, reopen the same link to continue where you left off."),
      el("p", {}, "Purpose (neutral description): we measure how people judge the execution of requested visual events in short generated clips, and how those judgments relate to automatic evaluation."),
      el("p", {}, "If you have questions, contact the study organizer (contact details were sent with your link)."),
      el("p", { class: "warn" }, "Do not share your link. Please finish each half of the session in one sitting."),
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
      el("p", {}, "Each task shows two videos side by side. Say which video does better."),
      el("ul", {},
        el("li", {}, el("b", {}, "Specification. "), "The intended scene and actions."),
        el("li", {}, el("b", {}, "Character pictures. "), "Labeled with the names from the specification — these are the people to look for in the panels and videos."),
        el("li", {}, el("b", {}, "Two videos, each with its own storyboard. "), "Click a storyboard to see it full size.")),
      el("p", {}, "Answer all four criteria on every task. The four criteria are independent — one video can win one and lose another."),
      el("h3", {}, "The four criteria"),
      ...CRITERIA.map(([id, name, desc]) => el("p", {}, el("b", {}, `${name}. `), desc)),
      el("h3", {}, "How to answer"),
      el("p", {}, el("b", {}, "Prefer Video 1 / Prefer Video 2: "), "that video is clearly better on this criterion. ",
                 el("b", {}, "Tie: "), "you cannot tell them apart. ",
                 el("b", {}, "Unratable: "), "the criterion cannot be judged at all (for example, neither video looks like the specification)."),
      el("h3", {}, "Three traps to avoid"),
      el("ul", {},
        el("li", {}, el("b", {}, "Hiding behind something. "), "If a character goes behind a screen and is supposed to come back, check that they do — and are still the same character."),
        el("li", {}, el("b", {}, "Small requested changes. "), "If only one character's cuff should turn stained, check that only that cuff changes, the change lasts, and the other character stays unchanged."),
        el("li", {}, el("b", {}, "Cuts. "), "Every case is one continuous shot with a fixed camera. A cut inside the video counts against Storyboard adherence."))),
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
      el("button", { class: "btn", onclick: next }, "Continue")));
}
function mediaUrl(key, kind) {
  const s = state.materials.stimuli[kind === "strip" ? "strips" : kind === "filmstrip" ? "filmstrips" : "clips"][key];
  return s ? "../" + s.path : null;
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
    el("h3", {}, "Specification"),
    el("div", { class: "spec" }, body),
    el("h3", {}, "Character references"),
    el("div", { class: "refs" }, ...refs.map((r, i) =>
      el("figure", { class: "refcard" },
        el("img", { src: r.src, alt: r.name ? `character reference: ${r.name}` : "character reference",
          title: "Click to see full size",
          onclick: () => openLightbox(srcs, i, (j, n) => refs[j].name ? `${refs[j].name} — ${j + 1} / ${n}` : `${j + 1} / ${n}`) }),
        r.name ? el("figcaption", {}, r.name) : null))),
    el("p", { class: "muted" },
      "Each reference is labeled with the character name used in the specification; ",
      "recognize those characters in the panels and videos. Click a reference to see it full size."));
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
  const lb = el("div", { id: "lightbox", role: "dialog", "aria-label": "Character reference, full size",
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

function videoCol(label, src, stripSrc, panelSrcs) {
  // storyboard strip: visible, permanent "click for full size" affordance —
  // the caption is a button-like pill below the strip (never overlays the panels)
  const openPanels = () => panelSrcs && openLightbox(panelSrcs, 0, (i, n) => `Panel ${i + 1} / ${n}`);
  return el("div", { class: "vcol" },
    el("div", { class: "vlabel" }, label),
    stripSrc ? el("figure", { class: "stripcard", onclick: openPanels },
      el("img", { class: "strip", src: stripSrc, alt: `${label} storyboard — click to see the panels full size`,
        title: "Click to see the panels full size" }),
      panelSrcs ? el("figcaption", {}, "⤢ Click to see the panels full size") : null) : null,
    el("video", { src, controls: "controls", loop: "loop", playsinline: "playsinline", preload: "auto" }));
}

function renderPreference(t) {
  // sides[0] = Video 1 (left). A repeat trial re-derives the original's sides
  // from the original trial id and flips them (guaranteed swapped-side repeat).
  const rng = prng(hashStr(RATER + "|" + (t.repeat_of_trial || t.id)));
  let sides = rng() < 0.5 ? ["A", "B"] : ["B", "A"];
  if (t.repeat_of_trial) sides = [sides[1], sides[0]];
  const labels = { left: `Video 1`, right: `Video 2` };
  const stripFor = (key) => t.showStrips && state.materials.stimuli.strips[key]
    ? mediaUrl(key, "strip") : null;
  const mk = (slot, key) => videoCol(labels[slot], mediaUrl(t.videos[key], "clip"),
    stripFor(t.videos[key]), panelUrls(t.videos[key]));

  // criteria per trial (all 4 since the Direct contrast was dropped; the list
  // stays per-trial in the materials schema)
  const critIds = t.criteria || CRITERIA.map(([cid]) => cid);
  const critRows = CRITERIA.filter(([cid]) => critIds.includes(cid)).map(([cid, name]) => {
    const rowName = `c_${cid}`;
    const cells = ["prefer1", "tie", "prefer2", "unratable"].map((v, j) =>
      el("td", {}, el("input", { type: "radio", name: rowName, value: v,
        onchange: () => { resp.criteria[cid] = v; check(); } })));
    return el("tr", {}, el("td", {}, name), ...cells);
  });

  const resp = state.responses[t.id] || (state.responses[t.id] = {
    id: t.id, type: t.type, case: t.case, contrast: t.contrast || null,
    gold: !!t.gold, repeat_of: t.repeat_of || null,
    side_map: { "Video 1": sides[0], "Video 2": sides[1] },
    criteria: {},
  });

  const btn = el("button", { class: "btn", disabled: "disabled", onclick: next }, "Next");
  function check() {
    btn.disabled = !critIds.every((cid) => resp.criteria[cid]);
  }
  check();

  const nStrips = [sides[0], sides[1]].filter((k) => stripFor(t.videos[k])).length;
  const head = nStrips === 2
    ? "Two results, each with its own supplied storyboard. For 'Storyboard adherence', judge each video against the storyboard shown with it. Click a storyboard to see its panels full size."
    : "Two results for the specification above.";

  $("#screen").replaceChildren(
    el("div", { class: "card" }, specBlock(t.case)),
    el("div", { class: "card" },
      el("h2", {}, head),
      el("div", { class: "videos" }, mk("left", sides[0]), mk("right", sides[1]))),
    el("div", { class: "card" },
      el("h2", {}, "Your judgments"),
      el("table", { class: "likert" },
        el("tr", {}, el("th", {}, "Criterion"), el("th", {}, "Prefer Video 1"),
          el("th", {}, "Tie"), el("th", {}, "Prefer Video 2"), el("th", {}, "Unratable")),
        ...critRows),
      ),
    btn);
}

function renderChecklist(t) {
  const c = state.materials.checklists[t.case];
  const req = c.requirements.find(r => r.id === t.reqId);
  const resp = state.responses[t.id] || (state.responses[t.id] = {
    id: t.id, type: t.type, case: t.case, reqId: t.reqId, stage: req.stage,
    dim: req.dim, output: t.output, evidence_mode: t.evidence ? t.evidence.mode : null,
    answer: null, evidence_loc: "",
  });

  const ansBtns = el("div", { class: "ynu" }, ...["yes", "no", "unresolved"].map(v =>
    el("label", {}, el("input", { type: "radio", name: "ynu", value: v,
      onchange: (e) => { resp.answer = e.target.value; btn.disabled = !(resp.answer && resp.evidence_loc.trim()); } }),
    v[0].toUpperCase() + v.slice(1))));

  const evInput = el("input", { type: "text", placeholder: req.stage === "plan" ? "panel number(s), e.g. 3 or 2–4" : "timestamp, e.g. 2.4s or 1.8–2.6s",
    onchange: (e) => { resp.evidence_loc = e.target.value; btn.disabled = !(resp.answer && resp.evidence_loc.trim()); } });
  evInput.value = resp.evidence_loc;
  const setEv = (v) => { evInput.value = v; resp.evidence_loc = v; btn.disabled = !(resp.answer && resp.evidence_loc.trim()); };

  // one-click evidence capture (no typing): video = current playback position,
  // plan = panel number buttons
  let capture = null;
  if (req.stage === "plan") {
    capture = el("span", {}, "Panel: ",
      ...[1, 2, 3, 4, 5, 6].map(n => el("button", { class: "btn ghost", style: "padding:4px 10px;margin:0 3px",
        onclick: () => setEv(String(n)) }, n)));
  }

  let evidence;
  if (req.stage === "plan") {
    evidence = el("img", { class: "filmstrip", src: mediaUrl(`${t.output}/${t.case}`, "strip"), alt: "six-panel output" });
  } else if (t.evidence && t.evidence.mode === "filmstrip") {
    evidence = el("div", {},
      el("img", { class: "filmstrip", src: mediaUrl(`${t.output}/${t.case}|${t.reqId}`, "filmstrip"), alt: "sampled frames" }),
      el("p", { class: "muted" }, "Only the frames sampled by the automatic evaluation are available for this item."));
    capture = el("span", {}, "Sampled frame: ",
      ...[1, 2, 3, 4, 5].map(n => el("button", { class: "btn ghost", style: "padding:4px 10px;margin:0 3px",
        onclick: () => setEv("frame " + n) }, n)));
  } else {
    const vid = el("video", { src: mediaUrl(`${t.output}/${t.case}`, "clip"), controls: "controls", loop: "loop",
      playsinline: "playsinline", preload: "auto" });
    evidence = el("div", {}, vid,
      el("div", { class: "row" },
        el("button", { class: "btn ghost", onclick: () => setEv(vid.currentTime.toFixed(1) + "s") },
          "Use current time")));
    capture = null;   // capture lives next to the video
  }

  const btn = el("button", { class: "btn", disabled: "disabled", onclick: next }, "Next");

  $("#screen").replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, "Requirement"),
      el("div", { class: "spec" }, req.text),
      el("p", { class: "muted" }, `Context: ${req.source}`)),
    el("div", { class: "card" },
      el("h3", {}, "Evidence"),
      el("div", { class: "evidence" }, evidence)),
    el("div", { class: "card" },
      el("h3", {}, "Your judgment"),
      el("p", {}, el("b", {}, "Yes: "), "visibly satisfied. ", el("b", {}, "No: "), "demonstrated violation. ",
        el("b", {}, "Unresolved: "), "insufficient visible evidence to decide."),
      ansBtns,
      el("p", {}, "Evidence location: ", evInput, " ", capture)),
    btn);
}

/* ---------------- flow ---------------- */
function trials() { return state.materials.assignment[RATER] || []; }

function renderTrial() {
  const ts = trials();
  if (state.trialIx >= ts.length) return go("done");
  const t = ts[state.trialIx];
  state.lastEnter = Date.now();
  $("#progress").textContent = `Item ${state.trialIx + 1} of ${ts.length}`;
  if (t.type === "preference" || t.type === "gold" || t.type === "repeat") renderPreference(t);
  else if (t.type === "break") renderBreak(t);
  else renderChecklist(t);
}

function next() {
  const t = trials()[state.trialIx];
  state.times[t.id] = (state.times[t.id] || 0) + (Date.now() - state.lastEnter);
  state.trialIx += 1;
  save();
  renderTrial();
}

function renderDone() {
  $("#progress").textContent = "Complete";
  $("#screen").replaceChildren(
    el("div", { class: "card" },
      el("h1", {}, "Thank you — done"),
      el("p", {}, "Download your results file and send it back as instructed. If the download does not start, use the button below."),
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
  else if (phase === "done") { save(); renderDone(); }
}

/* ---------------- boot ---------------- */
async function boot() {
  $("#screen").replaceChildren(el("p", { class: "muted" }, "Loading…"));
  if (!RATER) {
    $("#screen").replaceChildren(el("div", { class: "card" },
      el("h1", {}, "Missing participant code"),
      el("p", {}, "Please open the link you were given (it contains ?rater=…).")));
    return;
  }
  const [asg, chk, stu] = await Promise.all(["assignment", "checklists", "stimuli"].map(n =>
    fetch(`../materials/${n}.json`).then(r => { if (!r.ok) throw new Error(n); return r.json(); })));
  state.materials = { assignment: asg, checklists: chk, stimuli: stu };
  if (!asg[RATER]) {
    $("#screen").replaceChildren(el("div", { class: "card" },
      el("h1", {}, "Unknown participant code"),
      el("p", {}, `No assignment found for “${RATER}”.`)));
    return;
  }
  const saved = loadSaved();
  if (saved && saved.trialIx > 0) {
    Object.assign(state, { trialIx: saved.trialIx, responses: saved.responses, times: saved.times,
      quiz: saved.quiz, started: saved.started });
    if (state.trialIx >= trials().length) return go("done");
    return go("trials");
  }
  go("consent");
}
boot().catch(e => $("#screen").replaceChildren(el("div", { class: "card" },
  el("h1", {}, "Load error"), el("p", {}, String(e)))));