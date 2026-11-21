/* VisCraftBench human study — dynamic session deal (2026-11-21).
 *
 * Serving model (user, 2026-11-21): the store keeps an index of all
 * (case, contrast) pairs and how many ratings each has received (committed
 * sessions). When a rater claims a slot, the claim response carries those
 * counts and the page deals THIS session's queue from the least-covered
 * pairs — the pool is recomputed fresh at every claim. The dealt queue is
 * saved immediately (state.manifest) so later claims count it; resume always
 * walks the saved manifest, never a re-deal.
 *
 * The session shape is the frozen static design (proto/build_proto.py), so
 * static and dynamic manifests are interchangeable: per contrast the
 * least-covered cases become shuffled preference trials; halves are
 * [ceil-half + gold] / [rest + swapped-side repeat of the first]; merged as
 * [C1_a, C2_a, break, C2_b, C1_b] with the outer contrast alternating by slot
 * number (fatigue balance); gold = a FRESH spec case (not rated by this rater
 * in either contrast) with clips of two other cases (expected tie/unratable);
 * same-case trials >= 6 apart; a repeat >= 10 from its original.
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
      sample(a, n) { return this.shuffle(a.slice()).slice(0, n); },
    };
  }

  /* canonical (case, contrast) -> trial template, extracted from the frozen
   * static manifests (they contain every pair; nothing new is served, and the
   * opaque media keys keep the arms blinded). */
  function pairIndexFromAssignment(asg) {
    const idx = {};
    for (const slot of Object.keys(asg || {})) {
      for (const t of asg[slot] || []) {
        if (t && t.type === "preference" && t.case && t.contrast && !idx[t.case + "|" + t.contrast]) {
          idx[t.case + "|" + t.contrast] = { criteria: t.criteria, showStrips: t.showStrips, videos: t.videos };
        }
      }
    }
    return idx;
  }

  /* Deal one session's manifest from the least-covered pairs.
   * opts: { rater: "R5", coverage: {"case|contrast": n}, pairIndex,
   *         cases: [all case ids], contrasts: ["k1","k2"],
   *         nPer?: 11 (preference trials per contrast), goldCriteria?,
   *         rng?: () => [0,1) }                                     */
  function dealSession(opts) {
    const rater = opts.rater, coverage = opts.coverage || {}, pairIndex = opts.pairIndex;
    const cases = opts.cases, contrasts = opts.contrasts;
    const nPer = opts.nPer || 11;
    const R = mkRng(opts.rng);
    const key = (c, k) => c + "|" + k;
    const cov = (c, k) => coverage[key(c, k)] || 0;

    // 1) least-covered first (ties broken randomly) — "the pool that has
    //    received the least ratings so far"
    const picked = {};
    for (const k of contrasts) {
      const dec = cases.map((c) => ({ c: c, n: cov(c, k), r: R.next() }));
      dec.sort((a, b) => a.n - b.n || a.r - b.r);
      picked[k] = dec.slice(0, Math.min(nPer, dec.length)).map((d) => d.c);
    }

    // 2) gold spec cases: FRESH cases this rater does not rate in any contrast
    const used = new Set(contrasts.flatMap((k) => picked[k]));
    const fresh = cases.filter((c) => !used.has(c));
    const goldCases = R.sample(fresh.length >= contrasts.length ? fresh : cases, contrasts.length);

    // 3) outer contrast alternates by slot number (R1 has k1 outer — matches
    //    the frozen static manifests)
    const num = parseInt(String(rater).replace(/^R/i, ""), 10) || 1;
    const outer = num % 2 === 1 ? contrasts[0] : contrasts[1];
    const inner = contrasts.find((k) => k !== outer);

    let last = null;
    for (let attempt = 0; attempt < 5000; attempt++) {
      const halves = {};
      contrasts.forEach((k, ci) => {
        const cids = R.shuffle(picked[k].slice());
        const prefs = cids.map((cid) => {
          const tpl = pairIndex[key(cid, k)];
          return { type: "preference", kind: "preference", case: cid, contrast: k,
            criteria: tpl.criteria, showStrips: tpl.showStrips, videos: tpl.videos };
        });
        const pair = R.sample(cids, 2);        // two DIFFERENT cases for the gold clips
        const gold = {
          type: "gold", kind: "gold", case: goldCases[ci], gold: true, contrast: k,
          criteria: opts.goldCriteria || pairIndex[key(pair[0], k)].criteria
            .filter((c) => c.indexOf("sb_") !== 0),
          showStrips: false,
          videos: { A: pairIndex[key(pair[0], k)].videos.A, B: pairIndex[key(pair[1], k)].videos.B },
        };
        const nA = (cids.length + 1) >> 1;
        const first = prefs[0];
        const repeat = { type: "repeat", kind: "repeat", case: first.case, repeat_of: first.case,
          contrast: k, criteria: first.criteria, showStrips: true, videos: first.videos };
        halves[k] = { a: prefs.slice(0, nA).concat([gold]), b: prefs.slice(nA).concat([repeat]) };
      });
      const cand = [].concat(halves[outer].a, halves[inner].a,
        [{ type: "break", kind: "break" }], halves[inner].b, halves[outer].b);
      // blinding: any two same-case trials >= 6 apart (redraw if not)
      const pos = {};
      let okSpace = true;
      cand.forEach((t, i) => { if (t.case) (pos[t.case] = pos[t.case] || []).push(i); });
      for (const ps of Object.values(pos)) {
        for (let j = 1; j < ps.length; j++) if (ps[j] - ps[j - 1] < 6) okSpace = false;
      }
      cand.forEach((t, i) => { t.id = rater + "_" + String(i).padStart(3, "0"); });
      // repeats: link to the original trial + >= 10 apart (sides flip in app.js)
      let okRep = true;
      for (const t of cand) {
        if (t.type !== "repeat") continue;
        const orig = cand.find((x) => x.type === "preference" && x.videos === t.videos);
        t.repeat_of_trial = orig ? orig.id : null;
        if (!orig || Math.abs(cand.indexOf(t) - cand.indexOf(orig)) < 10) okRep = false;
      }
      if (okSpace && okRep) return cand;
      last = cand;
    }
    if (typeof console !== "undefined") {
      console.warn("deal: relaxed spacing constraints after 5000 redraws", rater);
    }
    return last;
  }

  const api = { dealSession, pairIndexFromAssignment };
  root.VCDEAL = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
