# Reads

Personal, offline-first PDF library and reader. Static site for GitHub Pages — no build step.

## Features
- Library grouped into sections (Finance, Education, Swift, DSA & Algorithms, …). Create, rename, reorder and delete sections; move books between them.
- **Continue reading** card plus a recently-read row. Resumes at the exact spot on the page.
- Reader: scroll or page-flip layout, fit width/page, zoom (buttons, ⌘/Ctrl + wheel, pinch), table of contents, bookmarks.
- Lighting: Day / Paper / Evening / Night presets, page tone (sepia, grayscale, dark, night), brightness, contrast, warmth (blue-light filter), reader background.
- Offline: app shell and pdf.js are cached by a service worker. Books you open are saved for offline use; *Settings → Download all books* saves the rest. Installable as an app (Add to Home Screen).
- Upload: add PDFs in the browser. They are saved on the device right away and committed to this repo (PDF and `library.json` in one commit) using your GitHub token. Offline uploads and edits are queued and sync when you're back online.

## Setup
1. Push this folder to `github.com/theMonk7/Reads` (branch `main`).
2. Repo → Settings → Pages → *Deploy from a branch* → `main` / root.
3. Open `https://themonk7.github.io/Reads/`.
4. To upload from the site, create a **fine-grained personal access token**:
   - Repository access: *Only select repositories* → `Reads`
   - Permissions: *Contents* → **Read and write**
   - Paste it in the site's Settings and click *Test connection*.

The token is stored only in that browser's localStorage. Never commit it.

## Files
| Path | Purpose |
|---|---|
| `library.json` | Catalog: sections and books (title, author, path, section) |
| `Books/` | PDFs |
| `js/library.js` | Library state, offline edit queue, GitHub sync |
| `js/reader.js` | pdf.js reader |
| `js/github.js` | GitHub Git Data API client |
| `sw.js` | Service worker. The app shell is served from cache as one snapshot, so **bump `VERSION` on every app change** or devices keep the old version |
| `vendor/pdfjs/` | pdf.js 4.10.38 (legacy build), Apache-2.0 |

## Adding books without the site
Copy the PDF into `Books/`, add an entry to `library.json`, and push.

## Notes
- GitHub rejects files over 100 MB; the uploader stops at 95 MB.
- GitHub Pages sites are public, even when the repo is private (outside Enterprise). Anyone with the URL can download the PDFs.
- Reading progress and bookmarks are stored per device; they don't sync between devices.
- After a commit, Pages takes about a minute to redeploy. The device that uploaded the book can read it immediately. Other devices with a token fetch it through the API in the meantime.
