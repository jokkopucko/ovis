# ovis.sh

The website of Ovis, the phone, desktop and browser client for herdr: the home page, the privacy
policy (`/privacy/`) and the support page (`/support/`) the App Store and Google Play ask for, and
the beta page (`/beta/`) that walks testers through joining the phone app tests.
It is plain HTML with no build, so edit the files and the next deploy serves them.

- The home page (`index.html`) carries its own styles and scripts. It is English as written;
  Simplified Chinese, Japanese and Korean come from the `#i18n-data` JSON in the same file, keyed
  by the English HTML of each text block, and the visitor picks one in the header (`?lang=zh`,
  `ja` or `ko` opens it directly; the choice is kept in `localStorage`). `/ko/` redirects to
  `/?lang=ko`. Change English text and its entry together, or the block stays English. Its links
  to `/beta/` (and `/beta/#…`) are pointed at `/zh/beta/`, `/ja/beta/` or `/ko/beta/` in the
  other languages, and those to `/privacy/` and `/support/` at `/ko/…` in Korean.
- It has a day and a night look (`data-theme` on `<html>`, the visitor's choice or the system
  setting); every screenshot has a `-light` and a `-dark` file, swapped by `data-light` /
  `data-dark`, and the mascot and logo have `-night` versions.
- The privacy, support, beta and 404 pages use `style.css`, in English at the root and Korean under
  `/ko/`. The beta page also has Simplified Chinese (`/zh/beta/`) and Japanese (`/ja/beta/`), with
  a language picker like the home page's; `_redirects` serves those two before its `/zh/*` and
  `/ja/*` rules, since Cloudflare follows a rule even where a file matches.

## Deploy

Cloudflare Pages serves it, connected to this repository:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | (empty) |
| Build output directory | `ovis-site` |
| Root directory | (empty) |
| Build watch paths, include | `ovis-site/*` |
| Custom domain | `ovis.sh` |

A push to `main` that touches `ovis-site/` deploys the site, and a pull request touching it gets a
preview address. Cloudflare serves `404.html` for a missing page and `/privacy` at `/privacy/`.

`_worker.js` is a Pages Function in advanced mode: `_routes.json` sends only `/demo` and `/demo/*`
to it, and it fetches those from the demo built into GitHub Pages (`https://herdrweb.dev/demo/`,
`.github/workflows/pages.yml`), so the demo opens at `ovis.sh/demo/` instead of redirecting to the
old domain. Every other path is a static file, with `_redirects` and `_headers` applied as before.
A preview deploy serves it too, so a pull request can check `/demo/` on its preview address.

## For search and answer engines

- `_headers` (Cloudflare's [headers file](https://developers.cloudflare.com/pages/configuration/headers/),
  not served) sends `X-Robots-Tag: noindex` for `ovis.pages.dev`, every preview at
  `<branch>.ovis.pages.dev` and `/README.md`, so ovis.sh is the copy search engines keep.
- The home page's `<head>` carries JSON-LD: the site, its maker, the app and its FAQ. The FAQ
  part repeats the visible FAQ word for word, minus the questions the test lists in `LEFT_OUT`;
  change both together. It states only what the repo does: no ratings, versions or dates.
- `llms.txt` ([llmstxt.org](https://llmstxt.org/)) tells answer engines what Ovis is, how to
  install it and where the docs are, and what it is not. Its facts come from the README and
  docs/guide.md; change it with them.
- The home page's title and description are translated in `#i18n-data` like the rest of the
  page, under their English text. `sitemap.xml` lists every indexable page with its language
  pair.
- `_redirects` hands the addresses people guess for the docs (`/docs`, `/guide`, `/install`,
  `/changelog`, `/faq`) to the guide, the README's install section, the changelog and the FAQ,
  and `/ja/` and `/zh/` to the home page in that language, so none of them ends on the 404 page.
- `scripts/ovis-site.test.ts` (Fast checks) keeps all of this true: canonicals, hreflang pairs,
  the sitemap, title and description lengths, the JSON-LD against the FAQ, the translations,
  llms.txt's links and the noindex rules. Each failure says what to change.

## Keep in step with the app

- The privacy policy states what the app keeps (the saved PC addresses and each PC's sign-in
  cookie), that the camera only reads the pairing QR code, and what the Ovis server's anonymous usage
  counts hold (docs/guide.md, "Anonymous usage counts"). Change it, and its date, in both
  languages when any of those changes, before the release that changes them.
- The beta page ships its iPhone and Android sections hidden; `assets/beta.js` shows each one once
  its link is set in `BETA_LINKS` there: the TestFlight public link, and the Google Group whose
  members may join the Google Play closed test. Its Windows tile downloads `Ovis.exe`, like the
  Windows download button in `assets/platform.js`, with the install command as a second way.
  The sections carry `id="iphone"` and `id="android"`: the home page's App Store and Google Play
  icons, and its download button on a phone (`assets/platform.js`), link to `/beta/#iphone` and
  `/beta/#android`.
- The support page names app labels (**Scan QR code**, **Forget**, **Change PC**) and Ovis server
  settings (**Settings → Phone & devices**, **Settings → About**); keep them matching the app.
- The screenshots in `assets/demo/` come from the demo build (`bun scripts/demo-build.ts <dir>`),
  never from a real session: English, light and dark theme, desktop at 1440×900 and phone at
  390×844, both at 2× (`chat`: the checkout-api chat, `approve`: the Codex approval, `terminal`:
  the release shell, `plan`: the plan panel, `workspaces`: the phone's workspace list).
  `approve-card-*` is the approval card cut out of the phone shot and `approve-base-*` the same
  shot without it, for the card's arrival in the hero.
- The quotes under "Loved by developers" are public posts on X, linked to each post, with the
  author's avatar saved in `assets/x/`.
- `assets/og-icon.png` is the link preview every page names (1200×630 PNG: the app icon, large, above
  the name, like an app's store page, so it still reads at a phone's card size). Remake it when the hero or the screenshots change.
- The Geist font in `assets/fonts/` is under the SIL Open Font License (`assets/fonts/LICENSE`).
- The icon and logo are the app's (`app/assets/`, `app/web/ovis-logo.png`).
