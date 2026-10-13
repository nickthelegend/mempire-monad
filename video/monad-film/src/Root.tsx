import React from "react";
import { MempireMonadFilm, MONAD_TOTAL } from "./films/monad/Film";
import { AbsoluteFill, Audio, Composition, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Cue, Fonts, Grain, MEMPIRE, Subtitles, Theme } from "./kit";
import { ActA } from "./scenes/ActA";
import { Gameplay } from "./scenes/Gameplay";
import { HowBuilt, Outro, TitleCard } from "./scenes/Sections";
import { ACT_A, C_START, FPS, G_LEN, G_START, H_LEN, H_START, TITLE_LEN, TITLE_START, TOTAL, VO_CUES, VO_CUES_A } from "./timeline";
import subs from "../public/vo/subtitles.json";
import { AppIntro, appLength } from "./apps/engine";
import { AppDemo, demoTimeline } from "./apps/demo";
import { DEMOS } from "./apps/demos";
import { MempireFilm, MEMPIRE_INTRO_BEATS } from "./films/mempire/Film";
import { PhonePulse, beatPulseAt } from "./kit/PhoneFlat";
import { PhoneTest } from "./films/test/PhoneTest";
import { PLAN as MEMPIRE_PLAN } from "./films/mempire/plan";
import { PolarisFilm, PolarisIntroFilm } from "./films/polaris/Film";
import { INTRO_PLAN as POLARIS_INTRO_PLAN, PLAN as POLARIS_PLAN } from "./films/polaris/plan";
import { JunoFilm, JunoIntroFilm } from "./films/juno/Film";
import { INTRO_PLAN as JUNO_INTRO_PLAN, PLAN as JUNO_PLAN } from "./films/juno/plan";
import { XorvFilm, XORV_TOTAL } from "./films/xorv/Film";
import { XorrFilm, XORR_TOTAL } from "./films/xorr/Film";
import { JUNO, POLARIS, XORR, XORV } from "./apps/configs";
import junoLines from "../vo/apps/juno/lines.json";
import xorrLines from "../vo/apps/xorr/lines.json";
import xorvLines from "../vo/apps/xorv/lines.json";
import polarisLines from "../vo/apps/polaris/lines.json";
import junoVo from "../public/apps/juno/vo/manifest.json";
import xorrVo from "../public/apps/xorr/vo/manifest.json";
import xorvVo from "../public/apps/xorv/vo/manifest.json";
import polarisVo from "../public/apps/polaris/vo/manifest.json";

const JunoIntro: React.FC = () => <AppIntro cfg={JUNO} lines={junoLines} manifest={junoVo} />;
const XorrIntro: React.FC = () => <AppIntro cfg={XORR} lines={xorrLines} manifest={xorrVo} />;
const XorvIntro: React.FC = () => <AppIntro cfg={XORV} lines={xorvLines} manifest={xorvVo} />;
const PolarisIntro: React.FC = () => <AppIntro cfg={POLARIS} lines={polarisLines} manifest={polarisVo} />;
const XorvDemo: React.FC = () => <AppDemo dc={DEMOS.xorv} lines={xorvLines} manifest={xorvVo} />;
const XorrDemo: React.FC = () => <AppDemo dc={DEMOS.xorr} lines={xorrLines} manifest={xorrVo} />;
const JunoDemo: React.FC = () => <AppDemo dc={DEMOS.juno} lines={junoLines} manifest={junoVo} />;
const PolarisDemo: React.FC = () => <AppDemo dc={DEMOS.polaris} lines={polarisLines} manifest={polarisVo} />;

// ---- MUSIC SLOT ----------------------------------------------------------------------
// TEMP bed synthesised by audio/synth.ts. To use a final track, put it at
// public/audio/music-final.wav and change MUSIC_SRC below (cuts are on a 120 BPM grid).
export const MUSIC_SRC = "audio/music.wav";
const MUSIC_GAIN = 0.5; // bed level before ducking
const DUCK = 0.316; // -10 dB under VO
/** Mempire intro bed: ElevenLabs cue (117.5 BPM), started 0.48 s in so its beats land on the 120 BPM cut grid. */
export const INTRO_MUSIC = { src: "films/mempire/audio/intro-eleven.mp3", startFrom: 14, gain: 0.32 };
// ---------------------------------------------------------------------------------------

type VoCue = { id: string; frame: number; dur: number; file: string };

const duckAt = (f: number, cues: VoCue[]) => {
  let g = 1;
  for (const c of cues) {
    const a = c.frame - 6;
    const b = c.frame + c.dur + 8;
    if (f < a - 6 || f > b + 10) continue;
    const k = interpolate(f, [a - 6, a, b, b + 10], [1, DUCK, DUCK, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    g = Math.min(g, k);
  }
  return g;
};

const Mix: React.FC<{ cues: VoCue[]; len: number; fadeOut?: boolean; music?: { src: string; startFrom: number; gain: number } }> = ({ cues, len, fadeOut, music }) => (
  <>
    <Audio
      src={staticFile(music?.src ?? MUSIC_SRC)}
      startFrom={music?.startFrom ?? 0}
      volume={(f) => (music?.gain ?? MUSIC_GAIN) * duckAt(f, cues) * (fadeOut ? interpolate(f, [len - 24, len], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1)}
    />
    <Audio src={staticFile("audio/sfx.wav")} volume={(f) => 0.55 * (fadeOut ? interpolate(f, [len - 10, len], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1)} />
    {cues.map((c) => (
      <Sequence key={c.id} from={c.frame} durationInFrames={c.dur + 10} name={`vo-${c.id}`}>
        <Audio src={staticFile(c.file)} volume={1} />
      </Sequence>
    ))}
  </>
);

const CUES = subs as unknown as Cue[];

const LaunchFilm: React.FC<{ theme: Theme }> = ({ theme }) => (
  <PhonePulse.Provider value={beatPulseAt(useCurrentFrame() / FPS, MEMPIRE_INTRO_BEATS)}>
  <AbsoluteFill style={{ background: theme.bg }}>
    <Fonts />
    <ActA theme={theme} />
    <Grain opacity={0.06} />
    <Subtitles theme={theme} cues={CUES.filter((c) => c.start * FPS < ACT_A)} />
    <Mix cues={VO_CUES_A} len={ACT_A} fadeOut music={INTRO_MUSIC} />
  </AbsoluteFill>
  </PhonePulse.Provider>
);

const FullDemo: React.FC<{ theme: Theme }> = ({ theme }) => (
  <AbsoluteFill style={{ background: theme.bg }}>
    <Fonts />
    <Sequence durationInFrames={ACT_A} name="Intro">
      <ActA theme={theme} />
    </Sequence>
    <Sequence from={TITLE_START} durationInFrames={TITLE_LEN} name="Title card">
      <TitleCard theme={theme} />
    </Sequence>
    <Sequence from={G_START} durationInFrames={G_LEN} name="Gameplay">
      <Gameplay theme={theme} offset={G_START} />
    </Sequence>
    <Sequence from={H_START} durationInFrames={H_LEN} name="How we built it">
      <HowBuilt theme={theme} offset={H_START} />
    </Sequence>
    <Sequence from={C_START} durationInFrames={TOTAL - C_START} name="Outro">
      <Outro theme={theme} />
    </Sequence>
    <Grain opacity={0.06} />
    <Subtitles theme={theme} cues={CUES} />
    <Mix cues={VO_CUES} len={TOTAL} />
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <>
    <Composition id="MempireActA" component={LaunchFilm} durationInFrames={ACT_A} fps={FPS} width={1920} height={1080} defaultProps={{ theme: MEMPIRE }} />
    <Composition id="MempireActA9x16" component={LaunchFilm} durationInFrames={ACT_A} fps={FPS} width={1080} height={1920} defaultProps={{ theme: MEMPIRE }} />
    <Composition id="JunoIntro" component={JunoIntro} durationInFrames={appLength(JUNO)} fps={FPS} width={1920} height={1080} />
    <Composition id="XorrIntro" component={XorrIntro} durationInFrames={appLength(XORR)} fps={FPS} width={1920} height={1080} />
    <Composition id="XorvIntro" component={XorvIntro} durationInFrames={appLength(XORV)} fps={FPS} width={1920} height={1080} />
    <Composition id="PolarisIntro" component={PolarisIntro} durationInFrames={appLength(POLARIS)} fps={FPS} width={1920} height={1080} />
    <Composition id="XorvDemo" component={XorvDemo} durationInFrames={demoTimeline(DEMOS.xorv, xorvVo).total} fps={FPS} width={1920} height={1080} />
    <Composition id="XorrDemo" component={XorrDemo} durationInFrames={demoTimeline(DEMOS.xorr, xorrVo).total} fps={FPS} width={1920} height={1080} />
    <Composition id="JunoDemo" component={JunoDemo} durationInFrames={demoTimeline(DEMOS.juno, junoVo).total} fps={FPS} width={1920} height={1080} />
    <Composition id="PolarisDemo" component={PolarisDemo} durationInFrames={demoTimeline(DEMOS.polaris, polarisVo).total} fps={FPS} width={1920} height={1080} />
    <Composition id="JunoIntroFilm" component={JunoIntroFilm} durationInFrames={JUNO_INTRO_PLAN.total} fps={FPS} width={1920} height={1080} />
    <Composition id="PolarisIntroFilm" component={PolarisIntroFilm} durationInFrames={POLARIS_INTRO_PLAN.total} fps={FPS} width={1920} height={1080} />
    <Composition id="JunoFilm" component={JunoFilm} durationInFrames={JUNO_PLAN.total} fps={FPS} width={1920} height={1080} />
    <Composition id="PolarisFilm" component={PolarisFilm} durationInFrames={POLARIS_PLAN.total} fps={FPS} width={1920} height={1080} />
    <Composition id="PhoneTest" component={PhoneTest} durationInFrames={150} fps={FPS} width={1920} height={1080} />
    <Composition id="MempireFilm" component={MempireFilm} durationInFrames={MEMPIRE_PLAN.total} fps={FPS} width={1920} height={1080} />
    <Composition id="MempireMonadFilm" component={MempireMonadFilm} durationInFrames={MONAD_TOTAL} fps={FPS} width={1920} height={1080} />
    <Composition id="MempireFull" component={FullDemo} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} defaultProps={{ theme: MEMPIRE }} />
    <Composition id="XorvFilm" component={XorvFilm} durationInFrames={XORV_TOTAL} fps={30} width={1920} height={1080} />
    <Composition id="XorrFilm" component={XorrFilm} durationInFrames={XORR_TOTAL} fps={30} width={1920} height={1080} />
  </>
);
