# Media extraction for links that aren't YouTube or Spotify (SoundCloud, Bandcamp, archive.org, direct
# files and the ~1800 other sites yt-dlp knows), plus SoundCloud search as a fallback source for songs
# YouTube won't hand over. Returns metadata and one browser-decodable audio format; the Next.js
# /api/media route does the downloading.

import json
from concurrent.futures import ThreadPoolExecutor
import os
import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import yt_dlp

BASE = dict(quiet=True, no_warnings=True, noplaylist=True, skip_download=True, socket_timeout=15, cachedir=False, playlist_items="1")
# browsers decode these with decodeAudioData; MPEG-TS segments are unpacked by /api/media
GOOD_EXT = {"m4a", "mp4", "mp3", "aac", "ogg", "oga", "opus", "webm", "wav", "flac", "weba", "mov", "ts"}
STREAMABLE = ("http", "https", "m3u8", "m3u8_native")


def score(f):
    """Lower is better: audio-only, plain HTTP, around 128 kbps, small."""
    audio_only = f.get("vcodec") in (None, "none")
    proto = f.get("protocol") or "https"
    abr = f.get("abr") or f.get("tbr") or 128
    size = f.get("filesize") or f.get("filesize_approx") or 0
    return (not audio_only, not proto.startswith("http"), abs(abr - 128), size)


def pick(info):
    formats = info.get("formats") or [info]
    ok = [
        f
        for f in formats
        if f.get("url")
        and f.get("acodec") != "none"
        and not f.get("has_drm")
        and (f.get("protocol") or "https") in STREAMABLE
        and (f.get("ext") in GOOD_EXT or f.get("acodec") not in (None, "none"))
        and not re.search(r"preview", f.get("format_id") or "", re.I)
    ]
    if not ok:
        return None
    f = min(ok, key=score)
    return {
        "url": f["url"],
        "protocol": f.get("protocol") or "https",
        "ext": f.get("ext"),
        "video": f.get("vcodec") not in (None, "none"),
        "headers": f.get("http_headers") or info.get("http_headers") or {},
        "bytes": f.get("filesize") or 0,
    }


def describe(info):
    title = info.get("track") or info.get("title") or "Untitled"
    artist = info.get("artist") or info.get("creator") or info.get("uploader") or info.get("channel")
    return {
        "title": title,
        "artist": artist,
        "duration": info.get("duration"),
        "site": (info.get("extractor_key") or "web").lower(),
        "page": info.get("webpage_url") or info.get("original_url"),
        "thumbnail": info.get("thumbnail"),
    }


def bandcamp(url):
    """Bandcamp shows yt-dlp a bot challenge but serves link-preview crawlers the normal page, whose
    data-tralbum attribute holds each track's 128 kbps MP3."""
    import html as H
    from urllib.request import Request, urlopen

    page = urlopen(Request(url, headers={"user-agent": "facebookexternalhit/1.1"}), timeout=15).read().decode("utf8", "replace")
    m = re.search(r'data-tralbum="([^"]+)"', page)
    if not m:
        raise ValueError("Couldn't read that Bandcamp page.")
    data = json.loads(H.unescape(m.group(1)))
    track = next((t for t in data.get("trackinfo") or [] if (t.get("file") or {}).get("mp3-128")), None)
    if not track:
        raise ValueError("That Bandcamp release has no streamable tracks.")
    art = re.search(r'<meta property="og:image" content="([^"]+)"', page)
    site = re.search(r'<meta property="og:site_name" content="([^"]+)"', page)
    return {
        "title": track.get("title") or data.get("current", {}).get("title") or "Untitled",
        "artist": track.get("artist") or data.get("artist") or (site and H.unescape(site.group(1))),
        "duration": track.get("duration"),
        "site": "bandcamp",
        "page": url,
        "thumbnail": art and art.group(1),
        "format": {"url": track["file"]["mp3-128"], "protocol": "https", "ext": "mp3", "video": False, "headers": {}, "bytes": 0},
    }


def youtube_cookies():
    """A signed-in session (Netscape cookies.txt, base64 in YT_COOKIES_B64) gets past YouTube's bot
    wall on cloud IPs. yt-dlp rewrites the file as cookies refresh, so it lives in /tmp."""
    b64 = os.environ.get("YT_COOKIES_B64")
    if not b64:
        return None
    path = "/tmp/yt-cookies.txt"
    if not os.path.exists(path):
        import base64

        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
    return path


def extract(url, client=None):
    if re.match(r"https?://[^/]*bandcamp\.com/", url):
        return bandcamp(url)
    opts = dict(BASE)
    if "youtube.com/" in url or "youtu.be/" in url:
        cookies = youtube_cookies()
        if cookies:
            opts["cookiefile"] = cookies
    if client:
        opts["extractor_args"] = {"youtube": {"player_client": client.split(",")}}
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(url, download=False)
    if info.get("entries"):
        info = next((e for e in info["entries"] if e), None)
        if not info:
            raise ValueError("That page has no playable media.")
    fmt = pick(info)
    if not fmt:
        raise ValueError("That page's audio is protected or in a format that can't be fetched.")
    return {**describe(info), "format": fmt}


def page_meta(url):
    """Title, artist and length from the page itself, for songs whose audio is DRM protected; the client
    then finds the same song on YouTube."""
    from urllib.request import Request, urlopen

    ua = {"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"}
    html = urlopen(Request(url, headers=ua), timeout=10).read(600_000).decode("utf8", "replace")
    meta = lambda name: (re.search(r'<meta[^>]+(?:property|name|itemprop)="%s"[^>]+content="([^"]*)"' % re.escape(name), html) or [None, None])[1]
    title = meta("og:title")
    artist = meta("music:musician_description") or meta("og:audio:artist")
    if "soundcloud.com" in url:
        try:
            o = json.loads(urlopen(Request("https://soundcloud.com/oembed?format=json&url=" + url, headers=ua), timeout=10).read())
            artist = o.get("author_name") or artist
        except Exception:
            pass
    duration = None
    iso = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", meta("duration") or "")
    if iso and any(iso.groups()):
        h, m, sec = (int(x or 0) for x in iso.groups())
        duration = h * 3600 + m * 60 + sec
    if not title:
        return None
    unescape = lambda t: t and t.replace("&amp;", "&").replace("&quot;", '"').replace("&#39;", "'").replace("&#x27;", "'")
    return {"title": unescape(title), "artist": unescape(artist), "duration": duration}


def words(s):
    return set(re.findall(r"[a-z0-9']+", (s or "").lower())) - {"the", "a", "an", "official", "audio", "video", "lyrics", "hd", "remastered", "remaster"}


def search(query, title, artist, duration):
    """The SoundCloud result that best looks like the original recording: full length (not a 30 s
    preview, not DRM), matching title and duration, by the artist rather than a cover or remix.
    Search results already carry title and duration, so only the best few are fully extracted."""
    with yt_dlp.YoutubeDL({**BASE, "extract_flat": True, "playlist_items": "1-20"}) as y:
        entries = y.extract_info(f"scsearch20:{query}", download=False).get("entries") or []
    want, by = words(title), words(artist)
    # other arrangements change the chords or the key; covers and live takes usually keep them
    changed = re.compile(r"\b(remix|rmx|mix|8d|slowed|sped|nightcore|reverb|mashup|edit|bootleg|flip|vip|metal|lofi|lo-fi|piano|orchestral|trap|phonk|dubstep|house|techno|bass ?boost(ed)?)\b", re.I)
    unwanted = re.compile(r"\b(cover|karaoke|instrumental|acoustic|live|tribute|version|unplugged)\b", re.I)
    ranked = []
    for rank, e in enumerate(entries):
        d = e.get("duration") or 0
        name = e.get("title") or ""
        if d < 45 or (duration and abs(d - duration) > max(6, duration * 0.04)):
            continue
        if want and len(want & words(name)) < (len(want) + 1) // 2:
            continue
        who = name + " " + (e.get("uploader") or "")
        if changed.search(name) and not changed.search(query):
            continue
        penalty = 2 * bool(unwanted.search(who) and not unwanted.search(query))
        penalty += bool(by and not by & words(who))
        penalty += (abs(d - duration) / 10 if duration else 0) + rank / 50
        ranked.append((penalty, e["url"]))
    ranked.sort()
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(try_extract, [u for _, u in ranked[:8]]))
    found = next((r for r in results if r), None)
    if not found:
        raise ValueError("No full-length copy of that song was found.")
    return found


def try_extract(url):
    try:
        return extract(url)
    except Exception:
        return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        key = os.environ.get("ADMIN_TOKEN")
        if key and self.headers.get("x-key") != key:
            return self.reply(403, {"error": "forbidden"})
        try:
            if q.get("q"):
                d = float(q["duration"]) if q.get("duration") else None
                out = search(q["q"], q.get("title", ""), q.get("artist", ""), d)
            elif q.get("url") and q.get("stream"):
                return self.stream(extract(q["url"], q.get("client")))
            elif q.get("url"):
                out = extract(q["url"], q.get("client"))
            else:
                return self.reply(400, {"error": "url or q required"})
            self.reply(200, out)
        except Exception as e:
            if "DRM" in str(e) and q.get("url"):
                song = None
                try:
                    song = page_meta(q["url"])
                except Exception:
                    pass
                return self.reply(422, {"error": "That track is copy-protected, so it can't be downloaded from there.", "song": song})
            if "Unsupported URL" in str(e):
                return self.reply(422, {"error": "That page doesn't have audio ChordCatch can fetch. Try a link to the song itself."})
            msg = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?", "", str(e)).split(". Use --")[0].split("\n")[0]
            self.reply(422, {"error": msg[:300]})

    def stream(self, info):
        """Downloads the audio from this same machine (YouTube ties stream URLs to the requesting IP)
        and passes it on in chunks."""
        from urllib.request import Request, urlopen

        f = info["format"]
        if not f["protocol"].startswith("http"):
            return self.reply(422, {"error": "not a plain stream"})
        meta = {k: info[k] for k in ("title", "artist", "duration", "site", "page", "thumbnail")}
        first = urlopen(Request(f["url"], headers={**f["headers"], "range": "bytes=0-0"}), timeout=20)
        total = int(first.headers.get("content-range", "/0").split("/")[1] or 0)
        self.send_response(200)
        self.send_header("content-type", {"m4a": "audio/mp4", "webm": "audio/webm", "mp3": "audio/mpeg"}.get(f["ext"], "application/octet-stream"))
        if total:
            self.send_header("content-length", str(total))
        self.send_header("x-media", __import__("urllib.parse").parse.quote(json.dumps(meta)))
        self.end_headers()
        pos, chunk = 0, 2 * 1024 * 1024
        while pos < total:
            end = min(total - 1, pos + chunk - 1)
            data = urlopen(Request(f["url"], headers={**f["headers"], "range": f"bytes={pos}-{end}"}), timeout=30).read()
            self.wfile.write(data)
            pos = end + 1

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    # local development: python api/ytdlp.py [port]
    import sys
    from http.server import ThreadingHTTPServer

    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 5328), handler).serve_forever()
