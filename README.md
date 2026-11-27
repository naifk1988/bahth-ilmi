# فهرس قناة «البحث العلمي»

موقع يعرض كل منشورات القناة داخله: العنوان والتصنيف ونص المنشور وصوره، مع تحميل ملفاته مباشرة.

- `data/posts.json` — الفهرس (العنوان، التصنيف، النوع، النص، بيانات الملف). العناوين والتصنيفات قابلة للتعديل يدويًا.
- `media/` — صور المنشورات.
- إصدار GitHub باسم `files` — ملفات القناة (PDF، وورد، إكسل، مقاطع…).
- `scripts/archive.py` + `.github/workflows/archive.yml` — يؤرشف القناة عبر بوت مشرف فيها، كل 3 ساعات.

الأسرار المطلوبة في Settings → Secrets and variables → Actions:
`TG_API_ID`، `TG_API_HASH` (من my.telegram.org)، `TG_BOT_TOKEN` (من BotFather).
