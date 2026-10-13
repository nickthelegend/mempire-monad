#!/usr/bin/env python3
"""Assemble the Mempire Metropolis demo: intro + live testnet segments + outro,
ElevenLabs narration, burned captions (PNG overlays) and an .srt.

  python3 assemble.py           (expects hf/intro.webm, hf/outro.webm, captures/A.webm, captures/B.webm, work/vo/lines.json)
"""
import json, os, subprocess, math
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(HERE, 'work'); os.makedirs(W, exist_ok=True)
FS = os.path.join(HERE, '..', 'app', 'node_modules', '@fontsource')
FPS = 30

def sh(*a):
    r = subprocess.run(a, capture_output=True, text=True)
    if r.returncode: raise SystemExit(f"FAILED {' '.join(a[:6])}…\n{r.stderr[-1500:]}")
    return r.stdout

# ── fonts (woff2 → ttf for PIL) ──────────────────────────────────────────────
def ttf(src, name):
    out = os.path.join(W, name)
    if not os.path.exists(out):
        f = TTFont(src); f.flavor = None; f.save(out)
    return out
LILITA = ttf(f'{FS}/lilita-one/files/lilita-one-latin-400-normal.woff2', 'lilita.ttf')
HANKEN = ttf(f'{FS}/hanken-grotesk/files/hanken-grotesk-latin-800-normal.woff2', 'hanken800.ttf')

def pill(text, path, size=34, bg=(255, 196, 34), fg=(27, 16, 48), font=LILITA, pad=(26, 12)):
    f = ImageFont.truetype(font, size)
    l, t, r, b = f.getbbox(text)
    w, h = r - l + pad[0] * 2, b - t + pad[1] * 2
    im = Image.new('RGBA', (w + 8, h + 12), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((4, 8, w + 4, h + 8), radius=h // 2, fill=(0, 0, 0, 90))
    d.rounded_rectangle((4, 4, w + 4, h + 4), radius=h // 2, fill=bg + (255,), outline=(27, 16, 48, 255), width=4)
    d.text((4 + pad[0] - l, 4 + pad[1] - t), text, font=f, fill=fg)
    im.save(path); return im.size

# ── the frame: quilt background, window labels, the LIVE tag ─────────────────
bg = os.path.join(W, 'frame.png')
im = Image.new('RGB', (1920, 1080), (20, 65, 143)); d = ImageDraw.Draw(im)
for y in range(1080):
    k = y / 1080; d.line([(0, y), (1920, y)], fill=(int(33 - 20 * k), int(96 - 54 * k), int(196 - 104 * k)))
for x in range(0, 1920, 92):
    for y in range(0, 1080, 92):
        d.polygon([(x, y), (x + 46, y + 46), (x, y + 92)], fill=None)
im.save(bg)
pill('●  LIVE · MONAD TESTNET', os.path.join(W, 'live.png'), size=30, bg=(255, 77, 109), fg=(255, 255, 255))
pill('PLAYER 1 · DESKTOP', os.path.join(W, 'lab_a.png'), size=24, bg=(13, 42, 92), fg=(255, 227, 138))
pill('PLAYER 2 · PHONE', os.path.join(W, 'lab_b.png'), size=24, bg=(13, 42, 92), fg=(255, 227, 138))

# ── segments of the live capture (seconds in captures/A.webm and B.webm) ─────
SEGS = [
    dict(id='heartbeat', a=3.0, b=15.3, vo='d01', tag='Monad testnet heartbeat · measured live in the browser'),
    dict(id='onboard', a=15.3, b=27.3, vo='d02', tag='Guest onboarding · the relayer mints the deck and sends MON + AUSD'),
    dict(id='arena', a=34.0, b=50.0, vo='d03', tag='Stake 0.01 MON (the $1 tier) · both players queue'),
    dict(id='battle', a=55.0, b=75.0, vo='d04', tag='Every card is a Monad transaction · exec / final ms per card'),
    dict(id='tower', a=117.5, b=124.5, vo=None, tag='Tower down'),
    dict(id='result', a=147.0, b=155.0, vo='d05', tag='Settled on chain by the second claim'),
    dict(id='empire', a=170.0, b=181.3, vo='d06', tag='Gasless chests on testnet: tx 0xb0ce…cc59 (EIP-7702 + paymaster)', hold=3.8),
    dict(id='clans', a=181.3, b=192.4, vo='d07', tag='Clans seeded by the team for the demo', hold=1.5),
]
lines = {l['id']: l for l in json.load(open(os.path.join(W, 'vo', 'lines.json')))}

clips = []
# intro (31.2 s) and outro (7 s) straight from the HyperFrames-style pages
def norm(src, out, start, dur):
    sh('ffmpeg', '-y', '-loglevel', 'error', '-ss', str(start), '-i', src, '-t', str(dur), '-vf', f'fps={FPS},scale=1920:1080,format=yuv420p', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out)
norm(os.path.join(HERE, 'hf', 'intro.webm'), os.path.join(W, 'c_intro.mp4'), 0.25, 31.2)
clips.append(('intro', os.path.join(W, 'c_intro.mp4'), 31.2))

A = os.path.join(HERE, 'captures', 'A.webm'); B = os.path.join(HERE, 'captures', 'B.webm')
for s in SEGS:
    dur = s['b'] - s['a']; hold = s.get('hold', 0)
    tag = os.path.join(W, f"tag_{s['id']}.png"); tw, _ = pill(s['tag'], tag, size=30)
    out = os.path.join(W, f"c_{s['id']}.mp4")
    fc = (f"[1:v]fps={FPS},scale=1333:996[a];[2:v]fps={FPS},scale=460:996[b];"
          f"[0:v][a]overlay=40:64[x];[x][b]overlay=1420:64[y];"
          f"[y][3:v]overlay=40:12[z3];"
          f"[z3][6:v]overlay=(1920-w)/2+260:12,tpad=stop_mode=clone:stop_duration={hold},fps={FPS},format=yuv420p[v]")
    sh('ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-framerate', str(FPS), '-t', str(dur), '-i', bg,
       '-ss', str(s['a']), '-t', str(dur), '-i', A, '-ss', str(s['a']), '-t', str(dur), '-i', B,
       '-i', os.path.join(W, 'live.png'), '-i', os.path.join(W, 'lab_b.png'), '-i', os.path.join(W, 'lab_a.png'), '-i', tag,
       '-filter_complex', fc, '-map', '[v]', '-t', str(dur + hold), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out)
    clips.append((s['id'], out, dur + hold))
    print('segment', s['id'], f'{dur + hold:.1f}s', flush=True)
norm(os.path.join(HERE, 'hf', 'outro.webm'), os.path.join(W, 'c_outro.mp4'), 0.15, 7.0)
clips.append(('outro', os.path.join(W, 'c_outro.mp4'), 7.0))

# ── concat ───────────────────────────────────────────────────────────────────
lst = os.path.join(W, 'concat.txt')
open(lst, 'w').write(''.join(f"file '{c[1]}'\n" for c in clips))
silent = os.path.join(W, 'video_silent.mp4')
sh('ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent)
starts = {}; t = 0.0
for cid, _, dur in clips: starts[cid] = t; t += dur
TOTAL = t

# ── narration placement ──────────────────────────────────────────────────────
place = {'i01': 0.5, 'i02': 2.4, 'i03': 12.9, 'i04': 19.3, 'i05': 25.5}
for s in SEGS:
    if s['vo']: place[s['vo']] = starts[s['id']] + 0.4
place['o01'] = starts['outro'] + 0.6
order = sorted(place, key=place.get)
for a_, b_ in zip(order, order[1:]):
    end = place[a_] + lines[a_]['seconds']
    if end > place[b_]: print(f'note: {a_} overlaps {b_} by {end - place[b_]:.2f}s → pushed'); place[b_] = end + 0.15
inputs = []; filt = []
for i, lid in enumerate(order):
    inputs += ['-i', os.path.join(W, 'vo', f'{lid}.mp3')]
    filt.append(f"[{i}:a]adelay={int(place[lid] * 1000)}|{int(place[lid] * 1000)}[a{i}]")
filt.append(''.join(f'[a{i}]' for i in range(len(order))) + f"amix=inputs={len(order)}:normalize=0,apad,atrim=0:{TOTAL:.2f},loudnorm=I=-16:TP=-1.5:LRA=11[out]")
voice = os.path.join(W, 'narration.m4a')
sh('ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', ';'.join(filt), '-map', '[out]', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', voice)

# ── captions: ≤ 7 words per card, timed from ElevenLabs' word alignment ──────
cards = []
for lid in order:
    ws = lines[lid]['words']; off = place[lid]; chunk = []
    for w in ws:
        chunk.append(w)
        if len(chunk) >= 7 or w['w'][-1] in '.:;?!' or (w['w'][-1] == ',' and len(chunk) >= 4):
            cards.append((off + chunk[0]['s'], off + chunk[-1]['e'] + 0.25, ' '.join(x['w'] for x in chunk))); chunk = []
    if chunk: cards.append((off + chunk[0]['s'], off + chunk[-1]['e'] + 0.25, ' '.join(x['w'] for x in chunk)))
for i in range(len(cards) - 1):  # no overlap
    if cards[i][1] > cards[i + 1][0]: cards[i] = (cards[i][0], cards[i + 1][0] - 0.02, cards[i][2])
srt = []
fmt = lambda x: f"{int(x // 3600):02d}:{int(x % 3600 // 60):02d}:{int(x % 60):02d},{int(round(x % 1 * 1000)) % 1000:03d}"
for i, (a_, b_, text) in enumerate(cards, 1): srt.append(f"{i}\n{fmt(a_)} --> {fmt(b_)}\n{text}\n")
SRT = os.path.join(W, 'captions.srt'); open(SRT, 'w').write('\n'.join(srt))
# caption PNGs, overlaid in batches to keep the filter graph small
cf = ImageFont.truetype(HANKEN, 40)
def cap_png(text, path):
    l, t, r, b = cf.getbbox(text); w, h = r - l + 56, b - t + 30
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w, h), radius=18, fill=(13, 18, 40, 200))
    d.text((28 - l, 15 - t), text, font=cf, fill=(255, 255, 255), stroke_width=0)
    im.save(path)
cur = silent; BATCH = 12
for bi in range(0, len(cards), BATCH):
    batch = cards[bi:bi + BATCH]; ins = ['-i', cur]; fc = []; last = '0:v'
    for j, (a_, b_, text) in enumerate(batch):
        p = os.path.join(W, f'cap_{bi + j:03d}.png'); cap_png(text, p); ins += ['-loop', '1', '-framerate', str(FPS), '-t', f'{TOTAL:.2f}', '-i', p]
        fc.append(f"[{last}][{j + 1}:v]overlay=(W-w)/2:H-h-36:eof_action=pass:enable='between(t,{a_:.3f},{b_:.3f})'[v{j}]"); last = f'v{j}'
    out = os.path.join(W, f'video_cap_{bi // BATCH}.mp4')
    sh('ffmpeg', '-y', '-loglevel', 'error', *ins, '-filter_complex', ';'.join(fc), '-map', f'[{last}]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out)
    cur = out
final = os.path.join(HERE, '..', 'docs', 'demo', 'mempire-metropolis.mp4'); os.makedirs(os.path.dirname(final), exist_ok=True)
sh('ffmpeg', '-y', '-loglevel', 'error', '-i', cur, '-i', voice, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', '-shortest', final)
open(final.replace('.mp4', '.srt'), 'w').write(open(SRT).read())
print(f'DONE {final} · {TOTAL:.1f}s · {len(cards)} captions')
