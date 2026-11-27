// يجلب من صفحة القناة العامة (t.me/s/...) نص كل منشور بروابطه وصوره وبيانات ملفه،
// ويضيف المنشورات الجديدة إلى الفهرس. يعمل في GitHub Actions، ولا يحتاج أي مفتاح.
//   node scripts/sync.mjs          ← يكمل ما نقص ويضيف الجديد
//   node scripts/sync.mjs --full   ← يعيد جلب كل المنشورات
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const FILE = new URL("data/posts.json", ROOT);
const MEDIA = new URL("media/", ROOT);
const db = JSON.parse(readFileSync(FILE, "utf8"));
const CH = db.channel;
const byId = new Map(db.posts.map(p => [p.id, p]));
db.skipped ??= [];
const skipped = new Set(db.skipped);
const FULL = process.argv.includes("--full");

const decode = s => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const textOf = h => decode(h.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();

// تصنيف آلي تقريبي للمنشورات الجديدة فقط
const RULES = [
  ["m", /مخطوط|تحقيق|فهرسة|التراث/], ["r", /رسائل|رسالة|أطروح|أطاريح|كشاف/],
  ["j", /مجلة|مجلات|محكم|سكوبس|scopus|isi/i], ["h", /حديث|السنة|تخريج/],
  ["q", /قرآن|القرآن|تفسير|مصحف|قراءات/], ["f", /فقه|فتاو|فتوى|قرارات|مجمع|زكاة|الهيئة الشرعية|قضائ|مواريث|نوازل|أنظمة/],
  ["a", /معجم|لغة|اللغة|نحو|إملائ|شعر/], ["t", /ذكاء اصطناعي|الذكاء|pdf|وورد|word|إكسل|excel|تطبيق|برنامج|chatgpt/i],
  ["g", /بوت|bot|قناة|قنوات|تيليجرام|تلجرام/i], ["l", /مكتبة|مكتبات|الشاملة|محرك|كتب|موسوعة/],
  ["s", /بحث|البحث|خطة|عنوان|عناوين|الباحث|مناقشة|كتابة/],
];
const classify = s => (RULES.find(([, re]) => re.test(s)) || ["x"])[0];

// يستخرج الـ div كاملًا مع ما بداخله من div متداخلة
function innerDiv(html, classPrefix) {
  const start = html.search(new RegExp(`<div class="${classPrefix}[^"]*"[^>]*>`));
  if (start < 0) return null;
  const open = html.indexOf(">", start) + 1;
  let depth = 1, i = open;
  const re = /<div\b|<\/div>/g; re.lastIndex = open;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index);
    i = re.lastIndex;
  }
  return html.slice(open);
}
const bgUrls = (part, cls) => [...part.matchAll(new RegExp(`class="${cls}[^"]*"[^>]*style="[^"]*background-image:url\\('([^']+)'\\)`, "g"))].map(m => m[1]);

function parse(html) {
  const out = [];
  const parts = html.split('<div class="tgme_widget_message_wrap').slice(1);
  for (const part of parts) {
    const idm = part.match(new RegExp(`data-post="${CH}/(\\d+)"`));
    if (!idm) continue;
    const id = +idm[1];
    if (/service_message/.test(part)) { out.push({ id, skip: true }); continue; }
    const rec = { id };
    const th = innerDiv(part, "tgme_widget_message_text");
    if (th) rec.html = th.trim();
    const text = th ? textOf(th) : "";
    const dm = part.match(/tgme_widget_message_document_title[^>]*>([\s\S]*?)<\/div>/);
    if (dm) {
      const em = part.match(/tgme_widget_message_document_extra[^>]*>([\s\S]*?)<\/div>/);
      rec.file = { name: textOf(dm[1]), size: em ? textOf(em[1]) : "" };
    }
    const photos = bgUrls(part, "tgme_widget_message_photo_wrap");
    if (photos.length) rec._photos = photos;
    if (/tgme_widget_message_video_player|tgme_widget_message_roundvideo/.test(part)) {
      rec.video = true;
      const vt = bgUrls(part, "tgme_widget_message_video_thumb");
      if (vt.length && !photos.length) rec._photos = vt.slice(0, 1);
      const dur = part.match(/message_video_duration[^>]*>([^<]+)</);
      if (dur) rec.duration = dur[1].trim();
    }
    const lp = part.match(/<a class="tgme_widget_message_link_preview" href="([^"]+)"/);
    if (lp) {
      const g = c => { const m = part.match(new RegExp(`class="${c}"[^>]*>([\\s\\S]*?)<\\/div>`)); return m ? textOf(m[1]) : ""; };
      rec.preview = { url: decode(lp[1]), site: g("link_preview_site_name"), title: g("link_preview_title"), desc: g("link_preview_description").slice(0, 300) };
    }
    const fw = part.match(/tgme_widget_message_forwarded_from_name[^>]*>([\s\S]*?)<\/(?:a|span)>/);
    if (fw) rec.fwd = textOf(fw[1]);
    const tm = part.match(/<time datetime="([^"]+)"/);
    if (tm) rec.date = tm[1].slice(0, 10);
    rec._text = text;
    out.push(rec);
  }
  return out;
}

async function get(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (bahth-ilmi index)" } });
    if (res.ok) return res;
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error("fetch failed " + url);
}
async function savePhotos(id, urls) {
  mkdirSync(MEDIA, { recursive: true });
  const names = [];
  for (let k = 0; k < Math.min(urls.length, 6); k++) {
    const name = `media/${id}${k ? "-" + k : ""}.jpg`;
    const dest = new URL(name, ROOT);
    if (!existsSync(dest)) {
      try { writeFileSync(dest, Buffer.from(await (await get(urls[k])).arrayBuffer())); }
      catch { continue; }
    }
    names.push(name);
  }
  return names;
}

let added = 0, updated = 0;
async function apply(items) {
  for (const r of items) {
    if (r.skip) { if (!skipped.has(r.id) && !byId.has(r.id)) { skipped.add(r.id); db.skipped.push(r.id); } continue; }
    let p = byId.get(r.id);
    if (!p) {
      if (skipped.has(r.id)) continue;            // مكرر مدموج في منشور آخر
      if (!r._text && !r.file && !r.video) { skipped.add(r.id); db.skipped.push(r.id); continue; } // صورة بلا نص أو منشور فارغ
      const first = (r._text.split("\n").map(s => s.replace(/^[^\p{L}\p{N}]+/u, "").trim()).find(s => s.length > 3) || "");
      let title = r.file ? r.file.name.replace(/\.(pdf|docx?|xlsx?|zip|rar|dotx|bok)$/i, "").replace(/_/g, " ").trim() : first;
      title ||= r.video ? "مقطع مرئي" : (r.preview?.title || "منشور مصوّر");
      if (title.length > 90) title = title.slice(0, 88).trim() + "…";
      let kind = "T";
      if (r.file) kind = /\.pdf$/i.test(r.file.name) ? "P" : "F";
      else if (r.video) kind = "V";
      else if (/apps\.apple\.com|play\.google\.com/.test(r.html || "")) kind = "A";
      else if (/href="https?:/.test(r.html || "") || r.preview) kind = "L";
      p = { id: r.id, title, cat: classify(title + " " + r._text), kind, auto: true };
      db.posts.push(p); byId.set(r.id, p); added++;
    }
    if (p.fetched && !FULL) continue;
    for (const k of ["html", "file", "video", "duration", "preview", "fwd", "date"]) if (r[k] !== undefined) p[k] = r[k];
    if (r._photos) p.photos = await savePhotos(r.id, r._photos);
    p.fetched = true; updated++;
  }
}

const needBackfill = FULL || !db.backfilled;
if (needBackfill) {
  // من الأحدث إلى الأقدم صفحةً صفحة
  let before = null;
  for (let page = 0; page < 200; page++) {
    const html = await (await get(`https://t.me/s/${CH}${before ? "?before=" + before : ""}`)).text();
    const items = parse(html);
    if (!items.length) break;
    await apply(items);
    const min = Math.min(...items.map(x => x.id));
    if (min <= 1 || (before && min >= before)) break;
    before = min;
  }
  db.backfilled = true; updated++;
} else {
  let after = Math.max(...db.posts.map(p => p.id), ...db.skipped, 0);
  for (let page = 0; page < 30; page++) {
    const items = parse(await (await get(`https://t.me/s/${CH}?after=${after}`)).text()).filter(x => x.id > after);
    if (!items.length) break;
    await apply(items);
    after = Math.max(...items.map(x => x.id));
  }
}

if (added || updated) {
  db.posts.sort((a, b) => a.id - b.id);
  db.updated = new Date().toISOString();
  writeFileSync(FILE, JSON.stringify(db, null, 1) + "\n");
}
console.log(`added ${added}, updated ${updated}, total ${db.posts.length}, missing text: ${db.posts.filter(p => !p.fetched).length}`);
