# Mission: القاعدة المدنية — Camera page, finger and pen vision ONLY

Date: 2026-10-29. Work solely on a separate branch. Do not change audio assets, narration mappings, translations, unrelated reader UI, production deployment or credentials.

## Required outcome (implement code, tests and a usable camera trial)
1. Detect which original book page is visible in a phone camera image, even if a page is only partially visible, cropped, skewed, tilted, or not centered. No assumption that all four page corners are present. Use content evidence (local visual feature matching and/or real Arabic-aware OCR), confidence and temporal consistency; do not guess a page number.
2. Detect the **real** index fingertip and a pointing **pen tip**. Pen and finger recognition must be based on visual evidence in the camera frame, not a static graphic or an arbitrary central click. Support finger-only and pen-only when reliably detectable; explicitly flag unsupported/uncertain pen cases instead of fabricating detection.
3. Identify the actual glyph/word being indicated by the tip *in the image*, with a small local ROI around the tip. Use both local character/word evidence and the recognized page content. Avoid selecting an adjacent or lower glyph; do not rely on static screen/page coordinates as the primary detector. If pointing to any letter inside a word, target the **whole word**; for isolated pedagogical letters, return the letter. No speech-library edits.
4. No trigger when no finger/pen or when ambiguous. Reject low confidence, occlusion, and ties. Temporal stabilization: avoid repeated triggers during a sustained point; allow re-trigger after deliberate lift-and-point. Include confidence and explainable debug overlays (actual detection box/tip/candidates).
5. Optimize camera pipeline for Android browsers, weak cameras, low-light, glare, shaky handheld motion, autofocus changes and rotation. Prefer local frame processing, throttled expensive page detection, light fast pointer tracking; no ongoing paid API dependencies.
6. Preserve the existing PWA reader and all 19 editions, existing PDF/audio mappings, and live production. Add a separate opt-in camera vision entry or trial route; no breaking navigation changes.

## Engineering acceptance tests
- Page top/bottom missing, zoomed/cropped, 30° perspective and rotation: robust page ID or explicit uncertain.
- No hand and no pen: ZERO output / ZERO audio event.
- Pointer at an Arabic word edge, two neighboring words, diacritics and multiple lines: correct word or uncertain, not neighbor by nearest screen pixel.
- Point with black pen, index finger, pen alone, finger leaving frame; suppress false positives.
- Mixed lighting, low exposure, dark shadows, glare, low resolution, page motion and partial-frame detection.
- Measure precision, false-trigger count and p50/p95 response latency using repeatable test harness. Report measured values only, never invented accuracy or claims.
- API should expose `pageId`, `targetText`, `kind`, `tip`, `confidence`, `sourceEvidence`, and `rejectionReason` for each accepted/rejected result.
- Add pure-logic unit tests with synthetic samples and browser smoke tests where possible. Clearly distinguish simulated tests from real-camera validation.

## Workflow / cost controls
- Run **only in a Claude CLOUD session using promotional cloud-session credit**; never use local Claude API/key, pay-as-you-go, credit purchase, or auto top-ups. If promo cannot be verified or is exhausted, STOP and make no further calls. Never claim a prompt can guarantee Anthropic's billing policy.
- First inspect the repository and identify existing implementation(s) and deployment; don't recreate unrelated features.
- Implement, test and commit on this isolated branch; prepare PR, but do not merge or deploy without verification.
- Keep concise, accurate progress + shortcomings, including unavailable models or real pen data. Don't claim production ready until on-device validation.

IMPORTANT: no scope expansion beyond page identification, local letters/words and hand/pen tracking.