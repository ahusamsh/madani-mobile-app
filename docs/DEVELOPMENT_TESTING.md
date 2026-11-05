# التطوير والاختبار — خطوات قابلة للتكرار

هذه التعليمات للمطور الجديد (مثل مسعود) على جهازه العادي. **لا تستخدم جهاز التدريب أو الـGPU الخاص بمشروعات أخرى**. متطلبات التشغيل الفعلي على الجوال مختلفة عن أدوات بناء الفهرس والاختبار المكتبي.

## 1. تجهيز البيئة

- Git ومستخدم GitHub لديه صلاحية المشروع، Node.js حديث (استُخدم Node 22 في فحوص Claude)، وChrome محلي لاختبارات المحاكاة.
- Python اختياري للتعامل مع PDF/الصوت؛ مطلوب فقط عند الحاجة إلى توليد الصور أو محاذاة التسجيلات.
- لا يوجد `package.json` يشغّل البناء: التطبيق PWA ثابت، وملفات JS لا تتطلب `npm build`.
- افتح المشروع عبر HTTP على `localhost` أو HTTPS؛ صلاحية الكاميرا لا تعمل بشكل مضمون من `file://` أو HTTP بعيد غير آمن.

```bash
git clone https://github.com/ahusamsh/madani-mobile-app.git
cd madani-mobile-app
git switch main
node scripts/serve.cjs
```

افتح `http://localhost:8765/` للقارئ، و`http://localhost:8765/vision/camera-v2.html` لتجربة الكاميرا. لإيقاف الخادم اضغط Ctrl+C في نفس نافذة الطرفية.

## 2. اختبار المصادر دون أي ملحقات

```bash
node scripts/qa.cjs
node --test vision/recognition-core.test.mjs vision/engine/units.test.mjs vision/engine/engine.test.mjs vision/v2/v2.test.mjs vision/v2/full-book.test.mjs
node scripts/audio-coverage.cjs
```

تعيد هذه الأوامر التحقق من المراجع والملفات الصوتية والأساس البصري. **الأمر الأخير يكتب ملفًا مشتقًا** هو `data/audio-coverage.json`؛ راجع فرق Git قبل Commit. توجد تجربة قديمة `vision/v2/extended-audio.test.mjs` تفترض حصر كل تسجيل في صفحة مصدره رغم وجود إعادة استعمال أصلية موثقة بين الصفحات؛ لا تعتبر الفشل في هذا الافتراض وحده تلفًا في الصوت.

## 3. اختبار المتصفح بمحاكاة الكاميرا

اختبارات `vision/bench/*` تستخدم `playwright-core` وChrome؛ **هي محاكاة وليست اختبار هاتف حقيقي**.

### تحضير Playwright بدون إضافته لتبعيات المشروع

```bash
# Linux/macOS (أو طرفية تدعم Bash)
npm install --prefix ../madani-dev-tools playwright-core
export NODE_PATH="$(cd ../madani-dev-tools && npm root)"
node vision/bench/run-v2.cjs
```

```powershell
# Windows PowerShell
npm install --prefix ..\madani-dev-tools playwright-core
$env:NODE_PATH = (Resolve-Path ..\madani-dev-tools\node_modules).Path
node vision\bench\run-v2.cjs
```

لازم يكون Chrome مثبتًا؛ تستخدم السكربتات قناة `chrome`. إذا استعملت نسخة Playwright مختلفة، تأكد من توافق API بدل تغيير ملفات المنتج. المخرجات متعلقة بالإطار والتشغيل والصوت وقد تُعدّل `vision/bench/results-*.json`؛ **لا ترفع تقارير متغيرة لم تراجعها**.

## 4. بناء الفهرس البصري والتحقق

```bash
# بعد تغيير صور الكتب أو صفحة مرجعية، ومن بيئة بها Playwright/Chrome
node vision/bench/build-index.cjs
node --test vision/v2/v2.test.mjs vision/v2/full-book.test.mjs
node scripts/build-offline-packs.cjs
```

`build-index.cjs` يكتب `vision/data/ref-index.bin`. لا تُنشئ فهرسًا جديدًا دون سبب؛ الأداة قد تستغرق وقتًا وتؤثر في دقة نتائج الصفحة. يجب حفظ الملف الثنائي في Git بعد فحص حجمه وعدد الصفحات الـ104.

## 5. اختبار V3 من فرع Claude

```bash
git fetch origin
git switch --track origin/feature/vision-v3-accuracy
node --test vision/recognition-core.test.mjs vision/engine/units.test.mjs vision/engine/engine.test.mjs vision/v2/v2.test.mjs vision/v2/full-book.test.mjs vision/v3/v3.test.mjs
```

على فرع V3، افتح `http://localhost:8765/vision/camera-v2.html?engine=v3`، واستخدم `?engine=v2` للمقارنة من النسخة نفسها. لا تقارن فرعًا قديمًا بفرع جديد دون تثبيت نسخة `audio-library.json` عند الحاجة.

توجد تقارير محفوظة على فرع V3: `vision/bench/results-v2-vs-v3.json` و`vision/bench/results-v3-offline.json`. أحدث تقرير وثيق الصلة هو PR #7: https://github.com/ahusamsh/madani-mobile-app/pull/7.

### ملاحظة مهمة جدًا عن Windows ونهايات الأسطر

بصمات `data/offline-packs.json` محسوبة على **البايتات الفعلية** للملفات (SHA-256). أضاف فرع V3 `.gitattributes` لتثبيت LF في JSON والتراخيص المعنية. إذا فشل اختبار بصمة الـOffline بعد الاستنساخ على Windows، تحقق بـ `git ls-files --eol data/audio-library.json data/edition-maps/ar.json`. لا تعدّل البصمات لتطابق ملفًا غيّره Checkout؛ أصلح نهايات الأسطر أو أعد توليد Manifest بعد استقرار الملفات.

## 6. مصفوفة الاختبار الميداني الإلزامية

| السيناريو | مثال الفحص | معيار النجاح |
|---|---|---|
| الحرف الصحيح | الصفحة 13، الموضع `p13-w19` (تَ) | تحديده وحده، بلا حرف مجاور |
| الحركات | صفحتا 47 و49 | الصفحة والفتحة/الكسرة صحيحتان |
| القلم القادم من اليمين | قلم داكن وفاتح | الطرف الصحيح؛ السكوت أفضل من نطق خاطئ |
| السبابة | ظهور جزئي للّيد واهتزاز | يتعرف على الطرف عندما تكفي الأدلة |
| صفحة جزئية | ربع صفحة/نصف صفحة | تعرف موثوق أو «غير مؤكد» |
| حروف متجاورة | صفحتا 25 و28 | بلا اختيار لجار خاطئ |
| لا مؤشر | الصفحة أمام الكاميرا وحدها | صفر نطق |
| كلمة متعددة الحروف | أشِر لأي حرف فيها | ينطق الكلمة كاملة، لا حرفها المفرد |
| صوت غير متوفر | منطقة غير مرتبطة | لا يُشغّل ملفًا بديلًا |
| Offline | تنزيل الحزم ثم وضع الطيران وإعادة الفتح | الكاميرا والملف الصوتي والقارئ يعملون دون اتصال |

اختبر أكثر من هاتف وفي إضاءات وزوايا متنوعة، مع الرجوع لنفس المنطقة في V2 وV3. احفظ في تقريرك نوع الهاتف والمتصفح، الصفحة، المعرف الصحيح، اختيار المحرك، هل اكتشف المؤشر، هل نطق الصحيح، الزمن التقريبي، وحالة الإنترنت. **لا تُصوّر وجوه الأطفال أو تجمع بيانات مستخدمين خاصة دون ضرورة وتصريح.**

## 7. مقاييس يجب الإبلاغ عنها

- `Correct target / Total attempts` مع فصل حالات السكوت وحالات الخطأ عن بعضها.
- `Wrong neighbour selection` لكل صفحة؛ لا تساوِ السكوت باختيار جار خاطئ.
- `False audio without pointer` (المطلوب صفر)، و`Wrong page`، و`Pointer recall`.
- زمن قبول الإشارة وزمن بدء الصوت P50 وP95؛ تجنّب الخلط بين زمن معالجة الإطار وزمن استجابة المستخدم.
- اكتمال الحزمة دون إنترنت بعد إيقاف الشبكة، وليس مجرد ظهور Service Worker.

## 8. دورة المساهمة

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/my-specific-fix
# عدّل واختبر
git status --short
git diff --check
git add <only-the-reviewed-files>
git commit -m "fix(vision): explain specific change"
git push -u origin feature/my-specific-fix
```

أنشئ Pull Request إلى `main` مع قبل/بعد، العينات ونتائج الاختبارات. لا تعمل مباشرة على الفرع الرئيسي ولا تدمج V3 دون إذن المشرف. إذا كان جهازك يملك تعديلًا محليًا غير مقصود، احفظه في فرع خاص قبل `git pull` ولا تسحق عمل مطور آخر.
