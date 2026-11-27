"""أرشفة قناة «البحث العلمي» كاملة داخل المستودع:
- نص كل منشور (بتنسيقه وروابطه) يُحفظ في data/posts.json
- الصور تُحفظ في media/
- الملفات والمقاطع تُرفع إلى إصدار GitHub باسم "files" وتُحمَّل من الموقع مباشرة
يعمل ببوت تيليجرام مشرف في القناة، فيستمر حتى لو أعيدت القناة خاصة.
آمن للإعادة: ما رُفع سابقًا لا يُنزَّل مرة أخرى.
"""
import asyncio, json, os, pathlib, re, subprocess, sys
from datetime import timezone
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.extensions import html as tghtml
from telethon.tl.types import (MessageMediaPhoto, MessageMediaDocument, MessageService,
                               DocumentAttributeFilename, DocumentAttributeVideo, PeerChannel)

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "posts.json"
MEDIA = ROOT / "media"
TAG = "files"
TMP = pathlib.Path("/tmp/tgdl")

db = json.loads(DATA.read_text(encoding="utf-8"))
posts = {p["id"]: p for p in db["posts"]}
skipped = set(db.get("skipped", []))

RULES = [
    ("m", r"مخطوط|تحقيق|فهرسة|التراث"),
    ("r", r"رسائل|رسالة|أطروح|أطاريح|كشاف"),
    ("j", r"مجلة|مجلات|محكم|سكوبس|scopus|isi"),
    ("h", r"حديث|السنة|تخريج"),
    ("q", r"قرآن|تفسير|مصحف|قراءات"),
    ("f", r"فقه|فتاو|فتوى|قرارات|مجمع|زكاة|الهيئة الشرعية|قضائ|مواريث|نوازل|أنظمة"),
    ("a", r"معجم|اللغة|لغة|نحو|إملائ|شعر"),
    ("t", r"ذكاء اصطناعي|الذكاء|pdf|وورد|word|إكسل|excel|تطبيق|برنامج|chatgpt"),
    ("g", r"بوت|bot|قناة|قنوات|تيليجرام|تلجرام"),
    ("l", r"مكتبة|مكتبات|الشاملة|محرك|كتب|موسوعة"),
    ("s", r"بحث|خطة|عنوان|عناوين|الباحث|مناقشة|كتابة"),
]
def classify(s):
    for c, rx in RULES:
        if re.search(rx, s, re.I):
            return c
    return "x"

def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout

def release_assets():
    try:
        out = gh("release", "view", TAG, "--json", "assets", "-q", ".assets[].name")
    except subprocess.CalledProcessError:
        gh("release", "create", TAG, "--title", "ملفات قناة البحث العلمي",
           "--notes", "ملفات القناة، تُرفع آليًا من سير العمل «أرشفة القناة».")
        return set()
    return {x for x in out.splitlines() if x}

def doc_info(msg):
    d = msg.media.document
    name = next((a.file_name for a in d.attributes if isinstance(a, DocumentAttributeFilename)), None)
    is_video = any(isinstance(a, DocumentAttributeVideo) for a in d.attributes)
    ext = pathlib.Path(name).suffix.lower() if name else ""
    if not ext:
        ext = {"video/mp4": ".mp4", "application/pdf": ".pdf", "audio/mpeg": ".mp3", "audio/ogg": ".ogg"}.get(d.mime_type, ".bin")
    if not name:
        name = f"{'مقطع' if is_video else 'ملف'} {msg.id}{ext}"
    return name, ext, d.size, d.mime_type, is_video

def first_line(text):
    for line in text.splitlines():
        line = re.sub(r"^[\s\W_]+", "", line).strip()
        if len(line) > 3:
            return line
    return ""

def save():
    from datetime import datetime
    db["posts"] = sorted(posts.values(), key=lambda x: x["id"])
    db["skipped"] = sorted(skipped)
    db["repo"] = os.environ.get("GITHUB_REPOSITORY", db.get("repo", ""))
    db["updated"] = datetime.now(timezone.utc).isoformat()
    DATA.write_text(json.dumps(db, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

async def main():
    api_id = int(os.environ["TG_API_ID"]); api_hash = os.environ["TG_API_HASH"]
    token = os.environ["TG_BOT_TOKEN"]
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.start(bot_token=token)
    if db.get("channel_id"):
        chan = await client.get_entity(PeerChannel(db["channel_id"]))
    else:
        chan = await client.get_entity(os.environ.get("TG_CHANNEL") or db["channel"])
        db["channel_id"] = chan.id

    assets = release_assets()
    MEDIA.mkdir(exist_ok=True); TMP.mkdir(exist_ok=True)
    start = 1
    known_max = max([*posts, *skipped, 0])
    empty_after_max = 0
    added = uploaded = 0

    while True:
        ids = list(range(start, start + 100))
        msgs = await client.get_messages(chan, ids=ids)
        found_any = False
        for mid, msg in zip(ids, msgs):
            if msg is None or isinstance(msg, MessageService):
                if msg is not None:
                    skipped.add(mid)
                continue
            found_any = True
            p = posts.get(mid)
            text = msg.message or ""
            entry_html = tghtml.unparse(text, msg.entities or []) if text else ""
            rec = {}
            if entry_html:
                rec["html"] = entry_html
            if msg.date:
                rec["date"] = msg.date.astimezone(timezone.utc).strftime("%Y-%m-%d")

            kind = None
            if isinstance(msg.media, MessageMediaPhoto):
                rel = f"media/{mid}.jpg"
                if not (ROOT / rel).exists():
                    await client.download_media(msg, file=str(ROOT / rel))
                rec["photo"] = rel
            elif isinstance(msg.media, MessageMediaDocument) and msg.media.document:
                name, ext, size, mime, is_video = doc_info(msg)
                asset = f"{mid}{ext}"
                if asset not in assets:
                    path = TMP / asset
                    print(f"↓ {mid} {name} ({size/1e6:.1f} MB)", flush=True)
                    await client.download_media(msg, file=str(path))
                    gh("release", "upload", TAG, str(path), "--clobber")
                    path.unlink(missing_ok=True)
                    assets.add(asset); uploaded += 1
                rec["file"] = {"name": name, "size": size, "mime": mime, "asset": asset}
                kind = "V" if is_video else ("P" if ext == ".pdf" else "F")

            if p is None:
                if not text and "file" not in rec and "photo" not in rec:
                    skipped.add(mid); continue
                title = ""
                if "file" in rec and not rec["file"]["name"].startswith(("ملف ", "مقطع ")):
                    title = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", rec["file"]["name"]).replace("_", " ").strip()
                title = title or first_line(text) or ("مقطع مرئي" if kind == "V" else "منشور مصوّر")
                if len(title) > 90:
                    title = title[:88].strip() + "…"
                if not kind:
                    kind = "A" if re.search(r"apps\.apple\.com|play\.google\.com", text) else ("L" if re.search(r"https?://", entry_html) else "T")
                p = {"id": mid, "title": title, "cat": classify(title + " " + text), "kind": kind, "auto": True}
                posts[mid] = p; added += 1
            p.update(rec)

        save()
        if found_any:
            empty_after_max = 0
        elif start > known_max:
            empty_after_max += 1
        if empty_after_max >= 2:
            break
        start += 100

    await client.disconnect()
    save()
    print(f"done: {added} new post(s), {uploaded} file(s) uploaded, {len(db['posts'])} total")

asyncio.run(main())
