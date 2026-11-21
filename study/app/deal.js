/* VisCraftBench human study — dynamic session deal (2026-11-21, rev 3).
 *
 * Serving model (user, 2026-11-21): the store keeps per-(case, contrast)
 * coverage = ANSWERED preference trials (partial sessions bank what they
 * answered; reserved-but-unanswered manifest pairs never count). When a
 * rater claims a session, the claim response carries those counts and the
 * page deals THIS session's queue from the least-covered pairs — the pool
 * is recomputed fresh at every claim. The dealt queue is saved immediately
 * (state.manifest) so resume always walks the saved manifest, never a
 * re-deal; answered trials are pushed to the store as they happen.
 *
 * Session shape (user, 2026-11-21): 27 preference trials — 9 per contrast —
 * plus 1 break at the midpoint = 28 items, ~30 min. NO gold attention
 * checks and NO swapped-side repeats (removed 2026-11-21); quality signals
 * live in cross-rater consistency, tie/unratable rates and timing.
 *
 * Cross-contrast case exclusion: a case is dealt at most once per session
 * (27 distinct cases), so every VIDEO appears at most once per session —
 * no same-case spacing rule is needed and no redraw loop exists.
 *
 * Order: trials are interleaved round-robin, one per contrast per round.
 * The leading contrast rotates by session number mod 3 AND by round, so
 * each contrast leads 3 of the 9 rounds in every session (position/fatigue
 * balance within and across sessions).
 *
 * Pairs come from ../materials/pairs.json (the flat 216-pair pool built by
 * proto/build_proto.py): { "case|contrast": {criteria, showStrips, videos} }.
 * Opaque media keys keep the arms blinded; sides are randomized per trial
 * in app.js.
 *
 * Pure module: no DOM, no fetch — usable from node (test/deal_test.js) and
 * from app.js (window.VCDEAL).
 */
(function (root) {
  "use strict";

  function mkRng(rand) {
    const r = rand || Math.random;
    return {
      next: r,
      shuffle(a) {
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
      },
    };
  }

  /* canonical (case, contrast) -> trial template, from the flat pairs pool
   * (site/materials/pairs.json contains every pair; nothing new is served,
   * and the opaque media keys keep the arms blinded). */
  function pairIndexFromPairs(pairs) {
    const idx = {};
    for (const pk of Object.keys(pairs || {})) {
      const t = pairs[pk];
      if (t && t.videos && t.criteria && !idx[pk]) {
        idx[pk] = { criteria: t.criteria, showStrips: t.showStrips, videos: t.videos };
      }
    }
    return idx;
  }

  /* Deal one session's manifest from the least-covered pairs.
   * opts: { rater: "R5", coverage: {"case|contrast": n}, pairIndex,
   *         cases: [all case ids], contrasts: ["k1","k2","k3"],
   *         nPer?: 9 (preference trials per contrast), rng?: () => [0,1) }
   * Returns the item list (27 preference trials + 1 break at the midpoint).
   * If the case pool is exhausted mid-deal (only possible with tiny test
   * pools), the session simply gets fewer preference trials.             */
  function dealSession(opts) {
    const rater = opts.rater, coverage = opts.coverage || {}, pairIndex = opts.pairIndex;
    const cases = opts.cases, contrasts = opts.contrasts;
    const nPer = opts.nPer || 9;
    const R = mkRng(opts.rng);
    const key = (c, k) => c + "|" + k;
    const cov = (c, k) => coverage[key(c, k)] || 0;
    const rotate = (a, r) => a.slice(r % a.length).concat(a.slice(0, r % a.length));

    // session number: leading contrast rotates by session mod 3 (R1 -> k1
    // first, R2 -> k2 first, R3 -> k3 first, ...)
    const num = parseInt(String(rater).replace(/^R/i, ""), 10) || 1;

    // deal round-robin: each round takes ONE case per contrast, always the
    // least-covered unused pair of that contrast (ties broken randomly) and
    // never a case already dealt to another contrast this session.
    const used = new Set();
    const rounds = [];
    for (let round = 0; round < nPer; round++) {
      const order = rotate(contrasts, num - 1 + round);   // leads rotate per round too
      const rtrials = [];
      for (const k of order) {
        const cands = [];
        for (const c of cases) {
          if (used.has(c)) continue;
          const tpl = pairIndex[key(c, k)];
          if (tpl) cands.push({ c: c, n: cov(c, k), r: R.next() });
        }
        if (!cands.length) continue;
        cands.sort((a, b) => a.n - b.n || a.r - b.r);
        const c = cands[0].c;
        used.add(c);
        const tpl = pairIndex[key(c, k)];
        rtrials.push({ type: "preference", kind: "preference", case: c, contrast: k,
          criteria: tpl.criteria, showStrips: tpl.showStrips, videos: tpl.videos });
      }
      if (rtrials.length) rounds.push(rtrials);
    }

    // flatten to the interleaved preference sequence, then one break at the
    // midpoint (14 prefs, break, 13 prefs = 28 items)
    const prefs = [].concat.apply([], rounds);
    const half = Math.ceil(prefs.length / 2);
    const items = prefs.slice(0, half)
      .concat([{ type: "break", kind: "break" }])
      .concat(prefs.slice(half));
    items.forEach((t, i) => { t.id = rater + "_" + String(i).padStart(3, "0"); });
    return items;
  }

  const api = { dealSession, pairIndexFromPairs };
  root.VCDEAL = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
