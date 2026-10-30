# Guest chat

A small public page where people the owner allowed can write to them, signed in with Google. The owner reads and answers in their own
app. Messages live in this page's own Firebase project; they are plain text with up to 3 pictures each (not end-to-end encrypted).

- `site/`: the page. Plain HTML and JavaScript, no build step; the Firebase SDK comes from Google's CDN. `site/config.js` holds the
  project's public web config (every Firebase web page ships one; the rules protect the data).
- `firebase/firestore.rules`: who may read and write what. Publish them with the Firebase console (Firestore -> Rules: paste the
  whole file, then Publish) or `firebase deploy --only firestore:rules` from `firebase/`. When a change needs both, publish the
  rules before the page.
- Pictures are part of the message (a list of bytes, no Storage). The page saves each one again as a JPEG of at most 1280 px and
  220 KB before it is sent (so the place a photo was taken does not go with it); the rules let in only JPEG, PNG and WebP by
  their first bytes, and the page draws only pictures that pass the same check, never SVG.
- `.github/workflows/pages.yml`: publishes `site/` to GitHub Pages on every push to `main`.

## Hard rules for this repo (it is public)

- Never commit a service-account key or any other private key, the owner's private chat config, the allowlist, or anyone's email
  address. The Pages workflow fails if a key file shows up; if one ever does, remove it from the history and make a new key.
- The allowlist lives only in Firestore (`allow/<email>`), edited by the owner.
- Commit with GitHub's noreply address, so no personal email ends up in the history.

## Try it locally

Serve `site/` at `http://localhost:<port>/` (Firebase allows sign-in from `localhost` by default), for example with
`bun scripts/guest.ts serve` in the owner's repo, or any static file server.
