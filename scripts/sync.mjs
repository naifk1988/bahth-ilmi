// يجلب المنشورات الجديدة من صفحة القناة العامة ويضيفها إلى data/posts.json
// يعمل في GitHub Actions كل بضع ساعات. لا يحتاج أي مفتاح.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../data/posts.json", import.meta.url);
const db = JSON.parse(readFileSync(FILE, "utf8"));
const CH = db.channel;
const known = new Set(db.posts.map(p => p.id));
db.skipped ??= [];
const skipped = new Set(db.skipped);

const decode = s => s
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// تصنيف آلي تقريبي بالكلمات المفتاحية (يمكن تعديله يدويًا في الملف لاحقًا)
const RULES = [
  ["m", /مخطوط|تحقيق|فهرسة|التراث/],
  ["r", /رسائل|رسالة|أطروح|أطاريح|كشاف/],
  ["j", /مجلة|مجلات|محكم|سكوبس|scopus|isi/i],
  ["h", /حديث|سنة النبوية|السنة|تخريج|الحديثي/],
  ["q", /قرآن|القرآن|تفسير|مصحف|قراءات/],
  ["f", /فقه|فتاو|فتوى|قرارات|مجمع|زكاة|هيئة شرعية|الهيئة الشرعية|قضائ|مواريث|نوازل|أنظمة/],
  ["a", /معجم|لغة|اللغة|نحو|إملائ|شعر/],
  ["t", /ذكاء اصطناعي|الذكاء|pdf|وورد|word|إكسل|excel|تطبيق|برنامج|chatgpt/i],
  ["g", /بوت|bot|قناة|قنوات|تيليجرام|تلجرام/i],
  ["l", /مكتبة|مكتبات|الشاملة|محرك|كتب|موسوعة/],
  ["s", /بحث|البحث|خطة|عنوان|عناوين|الباحث|مناقشة|كتابة/],
];
const classify = s => (RULES.find(([, re]) => re.test(s)) || ["x"])[0];

function parse(html) {
  const out = [];
  const parts = html.split('class="tgme_widget_message_wrap').slice(1);
  for (const part of parts) {
    const idm = part.match(new RegExp(`data-post="${CH}/(\\d+)"`));
    if (!idm) continue;
    const id = +idm[1];
    if (/service_message/.test(part)) { out.push({ id, skip: true }); continue; }
    const tm = part.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = tm ? decode(tm[1]).trim() : "";
    const dm = part.match(/tgme_widget_message_document_title[^>]*>([\s\S]*?)<\/div>/);
    const doc = dm ? decode(dm[1]).trim() : "";
    const video = /tgme_widget_message_video|tgme_widget_message_roundvideo/.test(part);
    const hasLink = /https?:\/\//.test(tm ? tm[1] : "");
    const firstLine = (text.split("\n").map(s => s.replace(/^[\s•▪️🔹🔸📌📚📖✅⭐️\-–—*]+/u, "").trim()).find(s => s.length > 3) || "");
    let title = doc ? doc.replace(/\.(pdf|docx?|xlsx?|zip|rar|dotx|bok)$/i, "").replace(/_/g, " ").trim() : firstLine;
    if (!title && video) title = "مقطع مرئي";
    if (!title) { out.push({ id, skip: true }); continue; }
    if (title.length > 90) title = title.slice(0, 88).trim() + "…";
    let kind = "T";
    if (doc) kind = /\.pdf$/i.test(doc) ? "P" : "F";
    else if (video) kind = "V";
    else if (/apps\.apple\.com|play\.google\.com/.test(part)) kind = "A";
    else if (hasLink) kind = "L";
    const desc = doc && firstLine && firstLine !== title ? firstLine.slice(0, 160) : "";
    out.push({ id, title, cat: classify(title + " " + text), kind, ...(desc ? { desc } : {}), auto: true });
  }
  return out;
}

let after = Math.max(...db.posts.map(p => p.id), ...db.skipped, 0);
let added = 0;
for (let page = 0; page < 30; page++) {
  const res = await fetch(`https://t.me/s/${CH}?after=${after}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const items = parse(await res.text()).filter(p => p.id > after);
  if (!items.length) break;
  for (const p of items) {
    if (p.skip) { if (!skipped.has(p.id)) { skipped.add(p.id); db.skipped.push(p.id); } continue; }
    if (known.has(p.id)) continue;
    db.posts.push(p); known.add(p.id); added++;
  }
  after = Math.max(...items.map(p => p.id));
}

if (added) {
  db.posts.sort((a, b) => a.id - b.id);
  db.updated = new Date().toISOString();
  writeFileSync(FILE, JSON.stringify(db, null, 1) + "\n");
}
console.log(`added ${added} new post(s); last id ${after}`);
