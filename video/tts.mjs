/**
 * ElevenLabs narration with word timings: one mp3 + alignment JSON per line.
 *   node --env-file=.env tts.mjs script.json [lineId ...]   (re-voices only the named lines, or new ones)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [, , scriptPath, ...only] = process.argv;
const spec = JSON.parse(readFileSync(scriptPath, 'utf8'));
const OUT = new URL(process.env.VO_DIR ?? './work/vo/', import.meta.url);
const manifestPath = new URL('lines.json', OUT);
const prev = existsSync(manifestPath) ? Object.fromEntries(JSON.parse(readFileSync(manifestPath, 'utf8')).map((l) => [l.id, l])) : {};
const out = [];
for (const line of spec.lines) {
  const say = line.say ?? line.text;
  const old = prev[line.id];
  const file = new URL(`${line.id}.mp3`, OUT);
  if (old && old.say === say && old.voice === spec.voice && existsSync(file) && !only.includes(line.id)) { out.push(old); continue; }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${spec.voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: say, model_id: spec.model ?? 'eleven_multilingual_v2', voice_settings: spec.settings ?? { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`${line.id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  writeFileSync(file, Buffer.from(j.audio_base64, 'base64'));
  const a = j.alignment;
  const seconds = a.character_end_times_seconds.at(-1);
  // Words with start/end, for captions.
  const words = []; let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { w: '', s: a.character_start_times_seconds[i], e: 0 };
    cur.w += ch; cur.e = a.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  out.push({ id: line.id, text: line.text, say, voice: spec.voice, seconds, words });
  console.log(`${line.id} ${seconds.toFixed(2)}s ${line.text.slice(0, 60)}`);
}
writeFileSync(manifestPath, JSON.stringify(out, null, 2));
console.log('total', out.reduce((a, l) => a + l.seconds, 0).toFixed(1), 's ·', out.reduce((a, l) => a + l.say.length, 0), 'chars');
