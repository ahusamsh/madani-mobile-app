# Delivery — Madani camera pointer → existing audio (2026-11-01)

Branch: `feature/vision-pointer-audio-engine-20261101`, based on PR #1 head `0d90146` (`feature/vision-camera-pointer-20261029`); PR target: that branch.
Commits: `4de6076` (engine, tests, trial), `d0d4f80` (trial e2e, cache, report), plus this note.
Status: **trial / not production-ready**. Nothing merged or deployed. No on-device (real phone camera) validation has been done.

## Base
The cloud checkout was a slim copy of PR #1: identical text files, but no `library-audio/*.mp3` and no `origin` remote. The work was built there and then cherry-picked unchanged onto the real PR #1 head `0d90146`. The `vision/` tree is byte-identical, and all tests were re-run on the new base (47/47 pass).

## What was built
All processing is local, in dependency-free JavaScript (`vision/engine/`). The previous trial's unpinned OpenCV/MediaPipe CDN downloads were removed. They were also unreachable from this environment.

| Step | How | File |
|---|---|---|
| Frame quality | mean / contrast / Laplacian sharpness → `weak-camera-*` reasons (distinct from "no pointer") | `engine/image.mjs` |
| Page identification from a partial view | FAST + rotated-BRIEF features on a pyramid. LSH matching against **all** indexed pages at once. Features common to many pages at the same position (frames, banners, grid lines) are excluded from ranking. Then a 4D Hough vote, RANSAC homography, and guided refinement. Finally a **dense content check** (lighting-normalised correlation of the registered page). Same-layout sibling pages are always compared, so the page is accepted only if it clearly beats them. | `engine/features.mjs`, `engine/page-matcher.mjs` |
| Tracking + caching | Per-frame guided tracking with the previous homography. Full-book identification throttled to 600 ms. New pages confirmed twice. Siblings re-checked every 1.2 s. Reference features and thumbnails cached in IndexedDB. Page pixels loaded lazily (LRU of 4). | `engine/engine.mjs`, `engine/browser-refs.mjs` |
| Finger / pen / pencil tip | **Image evidence, no hand landmarks.** The registered reference page is warped into the frame. Anything occluding the page that enters from outside it (by darkness, skin/colour chroma, or loss of print texture) is a pointer candidate. Tip = the most advanced point along the PCA axis of the last 25 mm, extended along the raw mask for thin pencil points. Pen vs finger is decided by physical width 8/16 mm behind the tip (mm from the registration scale) plus skin fraction. Unclear cases return `uncertain`. Pointers shorter than 22 mm, with the tip out of frame, or with no clear tip are rejected. Works for a pen with no hand visible. | `engine/pointer.mjs` |
| Word / isolated letter under the tip | Zones from `data/audio-library.json` (canonical page + zone ids). Any point inside a word selects the whole word. Isolated letters are `kind: 'letter'` (tatweel and harakat ignored). Rejected: gaps where no box is clearly closest, overlapping zones/ties, and occluded targets (<30% visible). Local pixel evidence: NCC of the live zone vs the reference zone must be ≥ 0.45. | `recognition-core.mjs` (`chooseTarget`), `engine/target.mjs` |
| Temporal gate | Stabilise ≥3 frames / 190 ms. Speak once per hold. Re-arm after the pointer has been absent for 180 ms. Moving deliberately to a different word is allowed. | `recognition-core.mjs` (`PointingGate`) |
| Audio | **Only pre-existing clips:** `segments[zoneId].clip` from the same page, or a parent box clip only when that box contains exactly this one zone. Same path safety rule as `app.js` `safeClip`. No mapping → result shows "not available", `play: false`, silent. No synthetic speech. The audio library was not modified. | `engine/target.mjs` |
| Opt-in trial route | `vision/camera-trial.html`: page outline, tip, candidate and accepted boxes, optional pointer mask and JSON debug, latency p50/p95. Arabic UI, sound toggle. Production reader UI (`index.html`, `app.js`) **unchanged**. | `camera-trial.*` |

Per-frame API (`VisionEngine.processFrame`): `accepted, play, pageId, targetText, targetId, kind, tip{frame,page}, pointerType, confidence, sourceEvidence{page,pointer,text,audio}, rejectionReason, audio{clip,segmentId,start,end,via}, timings`.

## Tests
- `node --test vision/recognition-core.test.mjs vision/engine/units.test.mjs vision/engine/engine.test.mjs` → **47 pass, 0 fail**. Contents:
  - unit tests: homography/RANSAC; page ID on rotated/tilted partial views; refusal of an unknown page; pointer detection for none, pen alone, pencil, pen in hand, finger, finger with hand in low light, cast shadow, dark shadow, glare, each frontal and rotated; tip leaving the frame; weak camera; local evidence; occlusion; Arabic letter/word kinds with harakat and tatweel; gaps and lines above; `safeClip`
  - **real library checks:** every one of the 143 segments resolves to an existing clip on its own page; `p17-w1` ا → `pilot-media/p015-word-001.mp3`; an unmapped page stays silent
  - synthetic end-to-end sequences: no pointer → 0 outputs; pen alone; finger with hand; hold → 1 trigger; lift and re-point → 1; rotated/tilted partial page; gap/margin → 0; no mapping → silent; dark frame → `weak-camera-dark`; unknown page → 0
- `NODE_PATH=$(npm root -g) node vision/bench/run-bench.cjs --pages=17,18,19,20,21,24,38,60,85 --zones=3` (headless Chromium + Playwright), output in `vision/bench/results-simulated.json`:
  - camera trial with Chromium's default fake camera (no book): **0 audio plays**, no page errors
  - **camera trial end-to-end:** a SIMULATED Y4M webcam stream of real page 17 with a pen on ج goes through `getUserMedia`, the engine, the UI "الصفحة 17 • حرف • قلم: ج", and plays **only** `pilot-media/p015-word-005.mp3` (the existing segment clip for `p17-w5`)
  - reader regression: home page loads with 19 editions and 143 linked clips, no errors

## Measured numbers — SIMULATED, not real camera
Frames were synthesised from the **real page images** (perspective, rotation, crop/zoom, gradient light, shadows, glare, noise, drawn pen/pencil/finger/hand), with all 89 reference pages indexed as distractors. Headless Chromium on a cloud x86 VM.

| Metric | Value |
|---|---|
| Target sequences (9 pages × 3 zones × 6 scenarios) | 162 |
| Correct triggers / **wrong triggers** | 107 / **0** (precision 1.000) |
| Recall per sequence, all pages / audio pages 17–21 | 0.66 / 0.86 (77/90) |
| No-pointer sequences → false triggers | 18 → **0** |
| Gap-between-words sequences → false triggers | 11 → **0** |
| Duplicate triggers while held | 0 |
| Frame latency p50 / p95 (desktop Chromium) | 83 ms / 184 ms |
| Reference indexing, 89 pages (first run, before cache) | 13.9 s |

Real-page identification check (Node, same synthetic method, 17 pages × 5 poses): 78 correct, **0 wrong**, 2 explicit "insufficient evidence" (extreme zoom on a page corner).

Low recall on pages 24, 38 and 85 comes from their `heuristic-pdf-extraction` zone maps, where boxes overlap. The engine correctly answers `ambiguous-neighbours` instead of guessing. These pages also have no audio.

**Not measured:** real phone cameras, Android performance, real pens and fingers (including children's fingers), autofocus hunting, motion blur, curved pages, and the colour print of the physical book. Precision, false-trigger and latency on device are therefore unknown. **Do not treat the trial as production-ready until it has been validated on a device.**

## Known limitations / outstanding
1. **On-device validation required.** Thresholds (`POINTER_DEFAULTS`: 170 mm page width, dark ratio 0.62, pen ≤ 9 mm / finger ≥ 9.5 mm at 8 mm behind the tip, 22 mm minimum visible length) are uncalibrated for children's fingers and real printed page size.
2. Mid-grey pens with no chroma, and hard shadows darker than about 0.62 of paper brightness, can be mis-segmented. A wooden pencil body reads as "skin" chroma; it is still classified by width.
3. Extreme zoom (more than about 2× page width, showing only a corner) → page "uncertain" until the user zooms out.
4. Only pages 17–21 (143 segments) have clip-level audio. All other pages stay silent by design. Zone maps for most pages are heuristic and overlap; they need human review.
5. 15 PDF pages have no reference image or zone map and are not indexed.
6. `sw.js` caches every same-origin GET cache-first. After updating `vision/*` on a deployed site, the trial can be served stale until the cache is cleared (the service worker was not changed, to avoid touching production).
7. First run indexes 89 pages on the device (13.9 s on desktop; expect more on a phone). The trial is usable on pages 17–21 almost immediately, because pages with audio are indexed first.

## Files changed
New: `vision/engine/{image,features,page-matcher,pointer,target,engine,synth,browser-refs}.mjs`, `vision/engine/{units,engine}.test.mjs`, `vision/bench/{bench.html,bench.mjs,scenarios.mjs,run-bench.cjs,results-simulated.json}`, `vision/CLAUDE_DELIVERY.md`.
Modified: `vision/recognition-core.mjs` (`chooseTarget` gap rule; `PointingGate` precomputed selection, `pageId`/`rejectionReason`, per-target re-arm), `vision/camera-trial.html`, `vision/camera-trial.mjs` (rewritten on the engine).
Untouched: `index.html`, `app.js`, `sw.js`, `data/*`, `pilot-media/*`, `library-clips/*`, books.
