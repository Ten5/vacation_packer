# CONTEXT.md — Multi-Trip Vacation Packing Checklist PWA

## 1. Project Overview & Goal
* **Objective:** Build an offline-capable, local-first Multi-Trip Vacation Packing Checklist Progressive Web App (PWA) with real-time progress tracking, multi-trip management, and cross-device JSON state transfer.
* **Core Features:**
  * Dynamic overall completion progress bar and per-category mini progress bars with live item/percentage counters.
  * Six core travel categories (*Clothing & Apparel*, *Toiletries & Grooming*, *Electronics & Tech*, *Travel Documents & Wallet*, *Fitness & Outdoor Gear*, *Miscellaneous Essentials*) with category-level `Pack All` / `Unpack All` toggles.
  * Custom item creation (per-category input and top Quick Add bar), quantity controls (`-` / `+`), item deletion, instant search, and status filtering (`All`, `To Pack`, `Packed`).
  * Multi-trip switcher bar allowing users to create (from Default Template, Unpacked Duplicate of Current Trip, or Blank Slate), rename inline, duplicate, and delete multiple simultaneous trips.
  * Cross-device synchronization via `.json` file export/import and raw JSON clipboard copy/paste (supporting both **All Trips Workspace** and **Current Trip Only** scopes, with **Merge/Add** or **Replace** import modes).
  * Full PWA support (`standalone` display mode, offline caching, and installability on desktop and mobile browsers).

## 2. Environment & Tech Stack
* **Development Environment:** Windows 11 PC (with WSL Ubuntu / Python 3.12 available for local HTTP testing via `python3 -m http.server 8080`), Antigravity IDE workspace.
* **Target Deployment:** Static HTTPS hosting via **GitHub Pages** (`https://<username>.github.io/<repo>/`) to satisfy Android Chrome's HTTPS requirement for `beforeinstallprompt` and standalone PWA installation.
* **Frontend Stack:**
  * Single-file architecture (`index.html`) using semantic HTML5 and Vanilla JavaScript (ES6+).
  * **Tailwind CSS** (loaded via CDN) for responsive layout and dark/light theme styling.
  * **Phosphor Icons** and **Google Fonts** (loaded via CDN).
  * Browser Web APIs: `localStorage`, Cache Storage API (`caches.open('packlist-pwa-v1')`), Web App Manifest, Service Worker API, FileReader/Blob API, and Clipboard API.

## 3. Architecture & Data Flow
* **File Structure:** Currently consolidated into a single `index.html` entry point (to be split into dedicated static PWA assets for production GitHub Pages compatibility).
* **State Schema (`localStorage`):**
  * Automatically migrates legacy single-trip schemas into a multi-trip workspace structure on load without data loss.
  * Workspace state tracks:
    * `activeTripId`: String identifier of the currently selected trip.
    * `theme`: `'light' | 'dark'`.
    * `trips`: Array of trip objects, each containing `id`, `title`, and `categories` (each category containing `id`, `name`, `icon`, and `items` with `id`, `name`, `qty`, `packed`, `isCustom`).
* **Data Flow & Sync:**
  * Every state mutation (checkbox toggle, quantity update, item add/delete, trip switch/rename/create) triggers an immediate UI re-render and synchronous write to `localStorage`.
  * **Export/Import Flow:** Serializes workspace or active trip state to JSON; import validates schema structure, resolves ID collisions on merge, updates `localStorage`, and re-renders.
  * **Offline & PWA Flow:** Pre-caches external CDN dependencies (Tailwind, Phosphor Icons, Google Fonts) into `packlist-pwa-v1` and monitors `navigator.onLine` to update the UI connectivity pill (`Online • PWA Ready` vs. `Offline Mode`).

## 4. Constraints & Non-Negotiables
* **Local-First & Zero-Backend Privacy:** All user data must remain strictly client-side in `localStorage` or user-controlled JSON files. Do not introduce third-party cloud databases, authentication walls, or telemetry.
* **HTTPS & Service Worker Scope Rules (Android Chrome):**
  * Android Chrome ignores inline `data:` URI service workers and refuses PWA installation over `file://` or plain HTTP local network IPs.
  * External Service Workers (`sw.js`) and Web App Manifests (`manifest.json`) must be served as real static files over HTTPS from the same origin root (e.g., GitHub Pages) using relative paths (`./sw.js`, `./manifest.json`) so subpath deployments (`/repo-name/`) do not break.
* **Backward Compatibility:** Any changes to the `localStorage` data structure must preserve backward-compatible migration logic for existing exported `.json` backups and saved browser states.
* **Single-File Portability (Fallback):** Keep inline SVG/Canvas icon generation or self-contained assets so the app degrades gracefully if opened locally without a server.

## 5. Immediate Next Steps (Actionable Tasks)
1. **Extract External `manifest.json` & Static Icons:** Move the dynamically generated inline Web App Manifest into a dedicated `manifest.json` file with relative paths (`"start_url": "./index.html"`, `"scope": "./"`), `"display": "standalone"`, `"theme_color": "#0284c7"`, and static `192x192` and `512x512` PNG app icons (`icons/icon-192.png`, `icons/icon-512.png`) so Android Chrome reliably detects installability.
2. **Extract Dedicated Service Worker (`sw.js`):** Replace the inline Data-URI service worker registration in `index.html` with a dedicated root `sw.js` file registered via `navigator.serviceWorker.register('./sw.js')`. Implement a cache-first / stale-while-revalidate fetch strategy for `./index.html`, `./manifest.json`, icons, and external CDN assets (`Tailwind`, `Phosphor Icons`, `Google Fonts`).
3. **Verify Subpath Routing & Offline Fallback:** Audit all asset references in `index.html`, `manifest.json`, and `sw.js` to ensure zero leading-slash root paths (`/`) that would fail when hosted on a GitHub Pages project subpath (`https://<user>.github.io/<repo>/`).
4. **End-to-End PWA & Sync Verification:** Test the multi-file bundle locally over `http://localhost:8080` (`python3 -m http.server 8080`) using Chrome DevTools (`Application > Manifest` and `Service Workers` tabs) to verify zero manifest errors, functional `beforeinstallprompt`, offline reload capability, and intact multi-trip JSON export/import.