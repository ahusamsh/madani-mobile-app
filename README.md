# القاعدة المدنية — تطبيق الجوال

تطبيق ويب تقدمي (PWA) مستقل، يعرض صفحات الكتاب الأصلية في PDF، ويقدم تصفح الصفحات والفهرس من علامات ملف PDF إن توفرت، والفهرس الرقمي، والبحث، وحفظ العلامة، والتكبير، وتغيير سرعة النطق. يدعم 19 طبعة ويستخدم الصوت العربي التعليمي في جميع الطبعات، لا تسجيلات مترجمة مزعومة.

مصدر المحتوى المحلي: مشروع madani-reader-audio/madani-reader-pwa. ملفات الكتب في books (19 طبعة)، بيانات الصوت في data/audio-library.json، خرائط الطبعات في data/edition-maps، والفهرس المستخرج من عناوين النسخة العربية (13 بابًا ومقدمة) في data/toc.json. تُطابق صفحات الطبعات المترجمة مع الفهرس باستخدام الصفحات الموثقة في الخرائط فقط. المقاطع في pilot-media وlibrary-clips، وتسجيلات الصفحات الكاملة في library-audio. عند وجود تسجيل كامل للصفحة، يُشغَّل ويُظلَّل المقطع المتزامن معه اعتمادًا على البداية والنهاية المسجلتين؛ وإذا لم يوجد تسجيل كامل، يمكن تشغيل المقاطع المنفصلة المرتبطة. لا يُفترض أن كل كلمة تملك توقيتًا صوتيًا.

**حالة الربط:** بيانات النسخة السابقة تضمنت مقاطع وروابط غير مدققة، وكثيرًا من المواضع دون أصوات. لهذا لا يختلق هذا التطبيق تسجيلًا للمقطع المفقود ولا يصنف التشغيل كاملاً للصفحة إذا لم تتوفر جميع المقاطع. الواجهة تعرض النسخ حتى في الصفحات التي لا تملك إحداثيات صوتية.

رابط التجربة المنشورة: https://madani-mobile-reader.vercel.app/ . افتح الرابط على أندرويد من Chrome واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية». لتشغيله محليًا من PowerShell داخل المشروع استخدم \`node scripts/serve.cjs\` ثم افتح \`http://localhost:8765\`.

الاختبارات المنجزة: فتح PDF العربي والإنجليزي، اختبار 19 طبعة موجودة، فهرس 14 قسمًا، ظهور 28 منطقة صوتية على الصفحة 17، تشغيل تسجيل الصفحة الكامل ونشاط التلوين عبر حدث نقر فعلي في Chromium. **غير مكتمل**: تدقيق جميع الأزمنة والمواضع من معلّم بشري؛ ترجمة واجهة التحكم لكل لغة؛ مراجعة تراخيص إعادة نشر الكتاب والصوتيات قبل التوزيع التجاري.

## الكاميرا الناطقة V2 (تجريبي، يعمل دون إنترنت)

- الصفحة: `vision/camera-v2.html` (روابط الكاميرا في التطبيق تفتحها). النسخة الأولى باقية في `vision/camera-trial.html`.
- كل المعالجة على الجهاز داخل Web Worker، دون CDN أو نماذج سحابية: التعرف على الصفحة، والإصبع والقلم، والكلمة أو الحرف، وقرار النطق، والصوت.
- العمل دون إنترنت: من قسم «التنزيل للعمل دون إنترنت» في صفحة الكاميرا، نزّل حزمتي `camera-ar` (16.5 م.ب) و`book-ar` (11.2 م.ب). يُتحقق من كل ملف بـSHA-256، ولا يحذف Service Worker الحزم عند تحديث التطبيق. الحزم الاختيارية: تسجيلات الصفحات (125 م.ب) وطبعات اللغات.
- بعد تعديل `data/audio-library.json` أو صور الصفحات أو المقاطع: `NODE_PATH=$(npm root -g) node vision/bench/build-index.cjs` ثم `node scripts/build-offline-packs.cjs`.
- الاختبارات:
  - `node --test vision/recognition-core.test.mjs vision/engine/units.test.mjs vision/engine/engine.test.mjs vision/v2/v2.test.mjs`
  - `node vision/bench/run-v2.cjs` (تنزيل الحزم، ثم إيقاف الخادم وإعادة فتح المتصفح دون إنترنت، ثم الكاميرا والنطق والقارئ)
  - `node vision/bench/run-compare.cjs` (مقارنة V1 وV2 على إطارات محاكاة)
- تغطية الصوت الحالية: 143 موضعًا فقط من 2907 لها تسجيل مستقل (حروف الصفحات 17–21)، ولا توجد كلمات بتسجيل مستقل بعد. لذلك يعرض النظام «الصوت غير متوفر» لبقية المواضع، ولا يشغّل تسجيلًا بديلًا.

## توسيع تغطية الكاميرا — نوفمبر 2026

- جرى دمج عمل Claude Offline Vision V2 كأساس؛ المحرك يعالج الفيديو والصور على الهاتف دون اتصال بخادم استدلال أو جهاز تدريب.
- جرى توسيع فهرس الصفحات المرجعية إلى **جميع الصفحات العربية الـ104** مع صور محلية مكملة للصفحات التي لم تكن لها صورة، دون حذف الصور أو الروابط الصوتية الأصلية. الصفحات قليلة التفاصيل قد لا تُعرّف بصريًا عندما لا تظهر سمات كافية؛ النظام يرفض التخمين.
- عند العثور على موضع صوتي مرتبط، يعمل **نطق الحرف/الكلمة الأصلية**. بخلاف ذلك لا يُختلق تسجيل؛ أضيف زر **سماع الصفحة كاملة** للصفحات ذات التسجيل الأصلي، مستقل عن النطق الفردي، ولا يُقدَّم على أنه صوت الحرف المشار إليه.
- توجد **143 وصلة صوتية دقيقة** من أصل 2,907 موضعًا مرشحًا، معظمها في الصفحات 17–21، و**90 تسجيل صفحة محفوظًا**؛ الربط التفصيلي لجميع الكلمات **غير مكتمل**. لا يجوز ادعاء خلاف ذلك.
- حزمة الكاميرا العربية تحوي صور جميع الصفحات وفهرس المطابقة والصوتيات المرتبطة، وتوجد حزمة مستقلة اختيارية لتسجيلات الصفحات الكاملة. بعد التنزيل والتحقق يمكن استخدام المحتوى المنزّل دون الإنترنت.
- اختبارات المحرك آلية ومحاكاة؛ دقة الاستخدام الحقيقي مع القلم والإصبع والإضاءة على الهواتف لا تزال بحاجة للتحقق الميداني. يُبقى محرك V1 للمقارنة والتراجع عند الحاجة.

**رابط التطبيق المستقل:** https://madani-mobile-reader.vercel.app/ — تظل استضافة GitHub Pages خلف العنوان الحالي، والتشغيل داخل المتصفح.

## مكتبة نطق الكلمات الموسعة — نوفمبر 2026

- **748 ربطًا صوتيًا فرديًا متاحًا** موزعة على صفحات متعددة من الكتاب العربي، منها **605 ربطًا جديدًا** مستخرجًا من تسجيلات القارئ الأصلية باستخدام محاذاة تفريغ صوتي عربي محلي، مع فحص مواضع النص من PDF وOCR محلي؛ ولا تتضمن أي صوت مولد.
- **3,024 منطقة نصية نشطة** في المكتبة، منها **2,276 منطقة لم تُربط بصوت فردي** بعد؛ ولا تُشغّل المنظومة صوتًا خاطئًا لهذه المناطق. جميع الروابط الجديدة `reviewed:false` و`machine-aligned-pending-listening` حتى تجري مراجعة سماعية بشرية. نسبة التغطية الفردية نحو 24.7% من المناطق الحالية، وليست تغطية شاملة للكتاب.
- فُصلت مواضع الحروف في صفحات الجداول التعليمية **25، 28، 31، 39، 41، 43** إلى 28 خلية لكل صفحة لتجنب أن تشير الكاميرا إلى أربعة حروف دفعة واحدة.
- يحتوي `vision/alignment/` على تفريغات صوتية مؤقتة ومحاولات OCR وسجل كل ربط للمراجعة، ويحتوي `vision/alignment/unmatched-words.json` على المواضع غير المرتبطة. إعادة إنشاء المقاطع: `py scripts/transcribe-book.py` ثم `py scripts/ocr-book.py` ثم `py scripts/build-word-audio.py` ثم `node scripts/audio-coverage.cjs` و`node scripts/build-offline-packs.cjs`. يتطلب التشغيل المحلي نماذج وأدوات مثبتة، ولا يستخدم جهاز التدريب.
- **حزمة الكاميرا العربية للعمل دون إنترنت:** 912 ملفًا تقريبًا، 32.4MB، شاملة الصور والفهرس والمقاطع المرتبطة، قابلة للتنزيل من التطبيق بعد اتصال أول. يظل تشغيل صفحات الكتاب الكاملة في حزمة مستقلة اختيارية.
- المراجع التفصيلية والاستخدام الميداني بالكاميرا على هاتف حقيقي لم تكتمل؛ يُرجى اختبار الصفحات ذات الروابط الجديدة قبل اعتمادها رسميًا.

## Audio expansion - 2026-11-02 (single-letter exact matching)

- Total linked original-audio targets: **906 of 3,025** currently eligible camera zones (**29.95%**). Newly linked: **66** isolated Arabic letters across **21 pages** (43 have a vowel mark, 23 are unvowelled).
- New segment mappings reuse **existing original Arabic recordings**, with exact base-letter and harakat signatures. Hamza variants and fatha/kasra/damma are deliberately kept distinct; no AI-generated recitation or approximate phonetic matches.
- Source-target provenance and original clip URL: `vision/alignment/reused-letter-clips-audit.json`; reproduction `py scripts/reuse-exact-letter-clips.py`; validation `py scripts/letter-reuse-qa.py` and `node scripts/qa.cjs`.
- All new and previous automatically created links are **pending listening/human review**, and remain silent if the exact recording cannot be mapped. More than two thousand visible zones are still unlinked.
- `camera-ar` offline pack manifest was rebuilt; users must update their downloaded offline pack to have the latest mappings offline. No connection to the training computer.


## Vision V3 — handover and reproducible workflow (2026-11-05)

Read [the V3 handover guide](docs/VISION_V3_HANDOVER.md) for repository/asset audit, local setup, engine architecture, test commands, offline-pack generation, branch and deployment policy, mobile QA and release/rollback procedures. V3 remains on the `feature/vision-v3-accuracy` branch (PR #7); production keeps V2 as the default. Simulation metrics are **not** evidence of smartphone-camera readiness.
