# VisCraft — anonymous project page

Static project page for the VisCraft submission (double-blind). No build step: open
`index.html` or serve this directory with any static host.

## Contents

- `index.html` — the page (title, abstract, method + teaser, qualitative results, results tables, BibTeX placeholder)
- `static/` — figures as PNG (web) and PDF (download)
- `scrub_assets.py` — strips PNG metadata and audits every shipped asset for identity strings

## Publish checklist (keep it anonymous)

1. Run `python3 scrub_assets.py` — must print `CLEAN` for every file, no `FORBIDDEN`.
2. Search the built files yourself: `grep -ri "<your name\|<institution\|<lab>" .`
3. Deploy from a **fresh account with no profile info**; one squashed initial commit with
   `user.name "Anonymous"` and the host's `noreply` email.
4. Prefer linking reviewers through an `anonymous.4open.science` mirror so the hosting
   account name is never exposed.
5. No analytics, no external fonts/CDNs, no video-platform embeds — keep it that way.
6. After acceptance: swap the author block and BibTeX; the URL can stay.

`scrub_assets.py` contains no personal information and is safe to publish, but it is not
linked from the page.