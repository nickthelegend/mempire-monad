#!/usr/bin/env python3
"""Assemble a Mempire video from a segment spec (JSON):
  python3 assemble2.py spec.json
spec = {"out": "../docs/demo/x.mp4", "vo": "work/vo-demo", "captures": "captures2",
        "segments": [ {"kind": "html", "src": "hf/x.webm", "start": 0, "dur": 6, "vo": ["p01"]},
                      {"kind": "live", "a": 10, "b": 30, "speed": 2, "tag": "…", "vo": ["s01"]} ]}
Each segment lasts max(footage, its narration + 0.6 s); footage holds its last frame to fit.
"""
import json, os, subprocess, sys
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
spec = json.load(open(sys.argv[1]))
NAME = os.path.splitext(os.path.basename(sys.argv[1]))[0]
W = os.path.join(HERE, 'work', NAME); os.makedirs(W, exist_ok=True)
FS = os.path.join(HERE, '..', 'app', 'node_modules', '@fontsource')
FPS = 30
def sh(*a):
    r = subprocess.run(a, capture_output=True, text=True)
    if r.returncode: raise SystemExit(f"FAILED {' '.join(map(str, a[:8]))}…\n{r.stderr[-1500:]}")
    return r.stdout
def ttf(src, name):
    out = os.path.join(HERE, 'work', name)
    if not os.path.exists(out):
        f = TTFont(src); f.flavor = None; f.save(out)
    return out
LILITA = ttf(f'{FS}/lilita-one/files/lilita-one-latin-400-normal.woff2', 'lilita.ttf')
HANKEN = ttf(f'{FS}/hanken-grotesk/files/hanken-grotesk-latin-800-normal.woff2', 'hanken800.ttf')

def wrap(text, font, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if font.getlength(t) <= width: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines
def rail_png(path, tag, speed):
    im = Image.new('RGBA', (232, 1080), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    big = ImageFont.truetype(LILITA, 26); small = ImageFont.truetype(HANKEN, 22)
    def box(y, lines, font, bg, fg, pad=14, lh=30):
        h = pad * 2 + lh * len(lines)
        d.rounded_rectangle((8, y + 4, 228, y + h + 4), radius=16, fill=(0, 0, 0, 90))
        d.rounded_rectangle((8, y, 228, y + h), radius=16, fill=bg, outline=(27, 16, 48, 255), width=3)
        for i, l in enumerate(lines): d.text((8 + pad, y + pad + i * lh), l, font=font, fill=fg)
        return y + h + 16
    y = box(44, ['● LIVE', 'MONAD TESTNET'], big, (255, 77, 109, 255), (255, 255, 255))
    if tag: y = box(y, wrap(tag, small, 190), small, (255, 196, 34, 255), (27, 16, 48), lh=28)
    if speed and speed != 1:
        h = 58
        d.rounded_rectangle((8, y + 4, 228, y + h + 4), radius=16, fill=(0, 0, 0, 90))
        d.rounded_rectangle((8, y, 228, y + h), radius=16, fill=(20, 241, 149, 255), outline=(27, 16, 48, 255), width=3)
        for k in (0, 1):  # the fast-forward glyph: two triangles
            x0 = 26 + k * 20; d.polygon([(x0, y + 15), (x0, y + h - 15), (x0 + 20, y + h / 2)], fill=(27, 16, 48))
        d.text((80, y + 12), f'×{speed:g}', font=big, fill=(27, 16, 48))
    im.save(path)
bgp = os.path.join(HERE, 'work', 'frame2.png')
if not os.path.exists(bgp):
    im = Image.new('RGB', (1920, 1080)); d = ImageDraw.Draw(im)
    for y in range(1080):
        k = y / 1080; d.line([(0, y), (1920, y)], fill=(int(33 - 20 * k), int(96 - 54 * k), int(196 - 104 * k)))
    im.save(bgp)

lines = {}
for root in {spec['vo']}:
    for l in json.load(open(os.path.join(HERE, root, 'lines.json'))): lines[l['id']] = l
CAP = os.path.join(HERE, spec.get('captures', 'captures2'))
A = os.path.join(CAP, 'A.webm'); B = os.path.join(CAP, 'B.webm')
clips, place = [], {}
t = 0.0
for i, s in enumerate(spec['segments']):
    vo = s.get('vo', []); gap = 0.25
    need = (0.35 + sum(lines[v]['seconds'] for v in vo) + gap * max(0, len(vo) - 1) + 0.5) if vo else 0
    out = os.path.join(W, f'seg{i:02d}.mp4')
    if s['kind'] == 'html':
        foot = s['dur']; dur = max(foot, need); hold = dur - foot
        sh('ffmpeg', '-y', '-loglevel', 'error', '-ss', str(s.get('start', 0)), '-i', os.path.join(HERE, s['src']), '-t', str(foot),
           '-vf', f'fps={FPS},scale=1920:1080,tpad=stop_mode=clone:stop_duration={hold:.3f},format=yuv420p', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out)
    elif s['kind'] == 'glimpse':
        foot = s['b'] - s['a']; dur = max(foot, need); hold = dur - foot
        x, y, w, h = s['crop']
        fc = (f"[1:v]crop={w}:{h}:{x}:{y},fps={FPS},scale=-2:1000[g];[0:v][g]overlay=(W-w)/2:40,"
              f"tpad=stop_mode=clone:stop_duration={hold:.3f},format=yuv420p[v]")
        sh('ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-framerate', str(FPS), '-t', f'{foot:.3f}', '-i', bgp,
           '-ss', str(s['a']), '-t', str(foot), '-i', os.path.join(HERE, s['src']),
           '-filter_complex', fc, '-map', '[v]', '-t', f'{dur:.3f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out)
    else:
        sp = s.get('speed', 1); foot = (s['b'] - s['a']) / sp; dur = max(foot, need); hold = dur - foot
        rail = os.path.join(W, f'rail{i:02d}.png'); rail_png(rail, s.get('tag'), sp)
        pts = f'setpts=PTS/{sp},' if sp != 1 else ''
        fc = (f"[1:v]{pts}fps={FPS},scale=1095:1012[a];[2:v]{pts}fps={FPS},scale=468:1012[b];"
              f"[0:v][a]overlay=40:44[x];[x][b]overlay=1158:44[y];[y][3:v]overlay=1672:0,"
              f"tpad=stop_mode=clone:stop_duration={hold:.3f},fps={FPS},format=yuv420p[v]")
        sh('ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-framerate', str(FPS), '-t', f'{foot:.3f}', '-i', bgp,
           '-ss', str(s['a']), '-t', str(s['b'] - s['a']), '-i', A, '-ss', str(s['a'] + s.get('bshift', 0)), '-t', str(s['b'] - s['a']), '-i', B,
           '-loop', '1', '-framerate', str(FPS), '-t', f'{foot:.3f}', '-i', rail,
           '-filter_complex', fc, '-map', '[v]', '-t', f'{dur:.3f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out)
    at = t + 0.35
    for v in vo: place[v] = at; at += lines[v]['seconds'] + gap
    clips.append((out, dur)); t += dur
    print(f'seg {i:02d} {s["kind"]:4s} {dur:5.1f}s  (total {t:5.1f})', flush=True)
TOTAL = t
lst = os.path.join(W, 'concat.txt'); open(lst, 'w').write(''.join(f"file '{c[0]}'\n" for c in clips))
silent = os.path.join(W, 'silent.mp4')
sh('ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent)
order = sorted(place, key=place.get); ins, filt = [], []
for i, lid in enumerate(order):
    ins += ['-i', os.path.join(HERE, spec['vo'], f'{lid}.mp3')]; ms = int(place[lid] * 1000)
    filt.append(f"[{i}:a]adelay={ms}|{ms}[a{i}]")
filt.append(''.join(f'[a{i}]' for i in range(len(order))) + f"amix=inputs={len(order)}:normalize=0,apad,atrim=0:{TOTAL:.2f},loudnorm=I=-16:TP=-1.5:LRA=11[out]")
voice = os.path.join(W, 'voice.m4a')
sh('ffmpeg', '-y', '-loglevel', 'error', *ins, '-filter_complex', ';'.join(filt), '-map', '[out]', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', voice)
cards = []
for lid in order:
    ws = lines[lid]['words']; off = place[lid]; chunk = []
    for w in ws:
        chunk.append(w)
        if len(chunk) >= 7 or w['w'][-1] in '.:;?!' or (w['w'][-1] == ',' and len(chunk) >= 4):
            cards.append([off + chunk[0]['s'], off + chunk[-1]['e'] + 0.25, ' '.join(x['w'] for x in chunk)]); chunk = []
    if chunk: cards.append([off + chunk[0]['s'], off + chunk[-1]['e'] + 0.25, ' '.join(x['w'] for x in chunk)])
for i in range(len(cards) - 1):
    if cards[i][1] > cards[i + 1][0]: cards[i][1] = cards[i + 1][0] - 0.02
fmt = lambda x: f"{int(x // 3600):02d}:{int(x % 3600 // 60):02d}:{int(x % 60):02d},{int(round(x % 1 * 1000)) % 1000:03d}"
srt = '\n'.join(f"{i}\n{fmt(a)} --> {fmt(b)}\n{tx}\n" for i, (a, b, tx) in enumerate(cards, 1))
cf = ImageFont.truetype(HANKEN, 40)
def cap_png(text, path):  # opaque caption card
    l, tt, r, b = cf.getbbox(text); w, h = r - l + 56, b - tt + 30
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w, h), radius=18, fill=(13, 18, 40, 255)); d.text((28 - l, 15 - tt), text, font=cf, fill=(255, 255, 255))
    im.save(path)
cur = silent; BATCH = 12
for bi in range(0, len(cards), BATCH):
    batch = cards[bi:bi + BATCH]; ins = ['-i', cur]; fc = []; last = '0:v'
    for j, (a, b, text) in enumerate(batch):
        p = os.path.join(W, f'cap_{bi + j:03d}.png'); cap_png(text, p); ins += ['-loop', '1', '-framerate', str(FPS), '-t', f'{TOTAL:.2f}', '-i', p]
        fc.append(f"[{last}][{j + 1}:v]overlay=(1672-w)/2:H-h-30:eof_action=pass:enable='between(t,{a:.3f},{b:.3f})'[v{j}]"); last = f'v{j}'
    out = os.path.join(W, f'cap_{bi // BATCH}.mp4')
    sh('ffmpeg', '-y', '-loglevel', 'error', *ins, '-filter_complex', ';'.join(fc), '-map', f'[{last}]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out)
    cur = out
final = os.path.join(HERE, spec['out']); os.makedirs(os.path.dirname(final), exist_ok=True)
sh('ffmpeg', '-y', '-loglevel', 'error', '-i', cur, '-i', voice, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', final)
open(final[:-4] + '.srt', 'w').write(srt)
print(f'DONE {final} · {TOTAL:.1f}s · {len(cards)} captions')
