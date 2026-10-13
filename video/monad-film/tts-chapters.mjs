// One ElevenLabs take per chapter → public/mm/vo/<ch>.mp3 + timing.json (dur, markers per beat, raw align).
import { readFileSync, writeFileSync } from 'node:fs';
const VOICE = 'IKne3meq5aSn9XLyUdCD';
const ch = JSON.parse(readFileSync(new URL('./chapters.json', import.meta.url), 'utf8'));
const out = {};
for (const [id, beats] of Object.entries(ch)) {
  const text = beats.map((b) => b[1]).join(' ');
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.42, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`${id}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  writeFileSync(new URL(`./public/mm/vo/${id}.mp3`, import.meta.url), Buffer.from(j.audio_base64, 'base64'));
  const a = j.alignment; const markers = {}; let pos = 0;
  for (const [name, s] of beats) { const idx = text.indexOf(s, pos); markers[name] = a.character_start_times_seconds[idx]; pos = idx + s.length; }
  out[id] = { id, file: `mm/vo/${id}.mp3`, dur: a.character_end_times_seconds.at(-1), text, markers, align: a };
  console.log(id, out[id].dur.toFixed(1), JSON.stringify(Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, +v.toFixed(1)]))));
}
writeFileSync(new URL('./public/mm/vo/timing.json', import.meta.url), JSON.stringify(out));
