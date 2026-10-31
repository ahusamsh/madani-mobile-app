# Claude Cloud Session Task — Madani Optical Pointer to Correct Audio (2026-10-31)

## Objective and strict scope
Work ONLY on Madani book page identification from a live camera, finger and pen-tip tracking, exact target letter/word recognition, and triggering the PRE-EXISTING correct audio asset (no audio generation). No redesign, translations, generic reader overhaul or unrelated optimization. The repository already has a WIP implementation in branch `feature/vision-camera-pointer-20261029` (PR #1); **inspect it and build upon it, not duplicate from scratch**.

### Product semantics
- Pointing at ANY letter inside a connected/printed word must speak the **entire word** using its existing audio mapping. If the teaching item is an isolated single letter/shape, speak only that item's defined sound. The audio behavior must follow the content mapping, not a guessed OCR pronunciation.
- The user can point with an index finger OR a pen/pencil/stylus. A pointing pen without the entire hand visible is a required scenario; recognize the tip using image evidence, not hand landmarks alone.
- Pages may be partially outside the camera frame, skewed, tilted, curved, overexposed, shadowed or zoomed; do NOT require seeing the entire book or fixed page dimensions.
- Determine target using actual local pixel evidence around the tip (image/OCR) and page-specific content for disambiguation, **not only nearest fixed coordinate on a template**.
- No pointer: no speech. No reliable target: no speech. Indicate uncertain confidence without inventing letters. Never speak the item beside or below the tip when not certain.
- Distinguish no visible pointer from weak camera; avoid repeated speech while holding an unchanged position; restart after lifting and repositioning.

## Implementation
1. Fetch `origin/feature/vision-camera-pointer-20261029` and base your changes on it. Initial files: `vision/recognition-core.mjs`, `vision/camera-trial.mjs`, `vision/camera-trial.html`, tests, book PDF in `books/ar.pdf`, and existing `app.js`, `data/audio-library.json`, `data/edition-maps/*`, `pilot-media/*`. Reuse rather than replace. Exclude any unrelated branches.
2. Fix any runtime bugs and add meaningful image-driven detection, confidence and correct focus ROI, fast-page-tracking with caching, robust real pen tip recognition, false-positive prevention. Choose free, local-first browser-friendly tools only. A non-trivial change MUST be validated with code and tests.
3. Connect **actual** target to an existing audio `segment` / linked clip using canonical page and item IDs. Treat absent mapping as "not available" and stay silent. Use deterministic audio assets, not synthetic speech; don't modify raw audio library unless objectively necessary and documented.
4. Add accessible and unobtrusive opt-in camera test route with usable debug overlays. Do not change production UI behavior by default. Show identified page, pointer type and accepted target when confident.
5. Unit/integration/browser tests including synthetic frames and realistic frames if repository contains them. Explicitly distinguish synthetic success from real camera validation. Test zero false trigger for no pointer, pen alone, index finger, neighbors, Arabic diacritics, multiple lines, rotated partial page, weak light, occlusion, weak camera, and no audio mapping.
6. Require on-device evidence before claiming production readiness. Add measured precision, false positive count and p50/p95 latency, or mark "not measured." No unverified accuracy claims.
7. Commit and push your code to **a new feature branch**, open a PR, or update existing PR #1 if using that branch. Provide `vision/CLAUDE_DELIVERY.md` with commit hashes, changed files, tests, audio linkage and outstanding issues.
8. Make the PR target `main` only when the total work includes the prerequisite vision branch; otherwise target existing vision branch PR #1. Do not force-push main, change production or merge yourself.

## Security and promotional balance
- Work as **Claude CLOUD session** only. The user expressly permits spending their promotional Claude cloud-session credit and does NOT consent to regular plan usage, pay-as-you-go, API usage, top-ups or additional payment.
- If the promotional balance cannot be verified/is exhausted, **STOP and report**. The in-prompt instruction is not itself an Anthropic billing limit: never claim it guarantees spending behavior.
- No secrets, credentials, personal data or keys committed. No external paid inference API.

## Acceptance
Only accept after verified image-based detection + word/letter mapping + real audio playback path, no false positives without pointer, passing tests, and no regression in existing reader. Focus on this task exclusively.