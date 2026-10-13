// MEMPIRE ON MONAD: the Solana film's game-trailer grammar (horizon stage, one phone, COMBO HUD, power-ups
// unlocked) with Monad testnet content. Every clip is the hosted app on Monad testnet; every "explorer"
// window is our proof page reading the transaction live from the Monad RPC.
import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Fonts, Grain, HorizonStage, MEMPIRE, Shake, sp, Subtitles, useUnit, withAlpha } from "../../kit";
import { settle, timeChunks, TimedCue } from "../../kit/chunk";
import beatsJson from "../../../public/mm/vo/beats.json";

const T = MEMPIRE;
const FPS = 30;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
type VO = { file: string; dur: number; text: string; align: never };
const VOS = beatsJson as unknown as Record<string, VO>;
const vf = (id: string) => Math.ceil((VOS[id]?.dur ?? 2) * FPS);

// ---------------------------------------------------------------- the edit
type Clip = { src: string; sec: number; startSec?: number };
type PlayCfg = { id: string; hud: string; combo: string; clip: Clip; extra?: number; moment?: string };
const c = (n: string, sec: number, startSec = 0): Clip => ({ src: `mm/clips/${n}.mp4`, sec, startSec });
export const PLAY: PlayCfg[] = [
  { id: "play_open", hud: "ENTER THE EMPIRE", combo: "LIVE ON MONAD", clip: c("open", 11.3), extra: 10 },
  { id: "play_signin", hud: "PASSKEY SIGN-UP", combo: "ONE PROMPT", clip: c("signin", 10.2), extra: 20 },
  { id: "play_deck", hud: "BUILD YOUR DECK", combo: "8 FIGHTERS", clip: c("deck", 16.0), extra: 20 },
  { id: "play_mint", hud: "MINT A FIGHTER", combo: "PYTH PRICE", clip: c("mint", 10.0), extra: 40 },
  { id: "play_stake", hud: "STAKE & QUEUE", combo: "0.01 MON", clip: c("stake", 19.5), extra: 30 },
  { id: "play_battle", hud: "RANKED BATTLE", combo: "EVERY CARD = A TX", clip: c("battle", 37.5), extra: 165 },
  { id: "play_tower", hud: "TOWER DOWN", combo: "SLOW-MO", clip: c("tower", 6.0), extra: 60 },
  { id: "play_result", hud: "SETTLED ON CHAIN", combo: "POT SECURED", clip: c("result", 15.5), extra: 75, moment: "POT SECURED!" },
  { id: "play_clans", hud: "CLAN WARS", combo: "DIAMOND HANDS", clip: c("clans", 16.0), extra: 30 },
  { id: "play_empire", hud: "EMPIRE", combo: "MONAD NATIVE", clip: c("empire", 24.0), extra: 45 },
];
type Power = { id: string; art: string; name: string; line: string; rarity: string; page: string; label: string; url?: string; extra?: number };
export const POWERS: Power[] = [
  { id: "how_cre", art: "art/cos/features/commit.webp", name: "Chainlink CRE meta", line: "36 fighters, buffed and nerfed on chain", rarity: "MYTHIC", page: "mm/explorer/cre.png", label: "MetaPosted · epoch 2986556", extra: 30 },
  { id: "how_pyth", art: "art/chest_magic.webp", name: "Pyth-priced mints", line: "A live price inside the mint tx", rarity: "EPIC", page: "mm/explorer/pyth.png", label: "Mint · BTC fighter", extra: 40 },
  { id: "how_gasless", art: "art/chest_golden.webp", name: "Gasless chests", line: "EIP-7702 + our paymaster · 0 MON spent", rarity: "LEGENDARY", page: "mm/explorer/gasless.png", label: "Type-4 tx · EntryPoint v0.8", extra: 30 },
  { id: "how_p256", art: "art/cos/features/siws.webp", name: "Passkeys on chain", line: "Checked by the P-256 precompile", rarity: "EPIC", page: "mm/explorer/p256-app.png", label: "In the app: eth_call to 0x0100 · tampered copy refused", url: "mempire-monad.vercel.app · Empire → Verify a passkey on Monad", extra: 40 },
  { id: "how_session", art: "art/cos/features/session.webp", name: "Session keys", line: "Every card play is a Monad tx", rarity: "RARE", page: "mm/explorer/play.png", label: "Played · from the session key", extra: 40 },
  { id: "how_settle", art: "art/chest_legendary.webp", name: "Settled by the contract", line: "90% to the winner, in the second claim", rarity: "LEGENDARY", page: "mm/explorer/settle.png", label: "MatchSettled · pot paid", extra: 40 },
];
const RARITY: Record<string, string> = { RARE: "#3FD6F2", EPIC: "#A27BFF", LEGENDARY: "#F2B33D", MYTHIC: "#FF5A7A" };

// ---------------------------------------------------------------- timeline
const LEAD = 8;
const TAIL = 14;
const INTRO = 300; // checklist
const TITLE = 75;
type Seg = { id: string; start: number; len: number; vo: number };
const lay = (ids: { id: string; extra?: number }[], start: number) => {
  let t = start;
  return ids.map((x) => {
    const len = LEAD + vf(x.id) + TAIL + (x.extra ?? 0);
    const s = { id: x.id, start: t, len, vo: t + LEAD };
    t += len;
    return s;
  });
};
const PLAY_START = INTRO + TITLE;
export const PLAY_SEGS = lay(PLAY, PLAY_START);
const HOW_START = PLAY_SEGS[PLAY_SEGS.length - 1].start + PLAY_SEGS[PLAY_SEGS.length - 1].len;
const HOW_INTRO = lay([{ id: "how_intro", extra: 6 }], HOW_START);
export const HOW_SEGS = lay(POWERS, HOW_INTRO[0].start + HOW_INTRO[0].len);
const ALL = lay([{ id: "how_all", extra: 24 }], HOW_SEGS[HOW_SEGS.length - 1].start + HOW_SEGS[HOW_SEGS.length - 1].len)[0];
const OUTRO = lay([{ id: "outro_tag", extra: 60 }], ALL.start + ALL.len)[0];
export const MONAD_TOTAL = OUTRO.start + OUTRO.len;
const ALL_VO: Seg[] = [...PLAY_SEGS, ...HOW_INTRO, ...HOW_SEGS, ALL, OUTRO];
const CUES: TimedCue[] = settle(ALL_VO.flatMap((s) => timeChunks(VOS[s.id].text, s.vo / FPS, VOS[s.id].dur, VOS[s.id].align)));
const voiceOn = (f: number) => ALL_VO.some((s) => f >= s.vo - 6 && f <= s.vo + vf(s.id) + 8);

// ---------------------------------------------------------------- pieces
const Flash: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [at, at + 1, at + 3], [0, 0.85, 0], clamp);
  return o > 0 ? <AbsoluteFill style={{ background: "#fff", opacity: o }} /> : null;
};

const SCREEN_AR = 498 / 1083; // the padded clip
const CROP = 67 / 1083; // the pad above the app's own header
const Screen: React.FC<{ clip: Clip; h: number; rate: number; border?: boolean }> = ({ clip, h, rate, border = true }) => {
  const { u } = useUnit();
  const fullH = h / (1 - CROP);
  const w = fullH * SCREEN_AR;
  return (
    <div style={{ position: "relative", width: w * u, height: h * u, overflow: "hidden", borderRadius: 30 * u, background: "#060914", boxShadow: border ? `0 0 0 ${4 * u}px ${T.primary}, 0 0 ${70 * u}px ${withAlpha(T.primary, 0.45)}, 0 ${30 * u}px ${90 * u}px rgba(0,0,0,0.7)` : undefined }}>
      <OffthreadVideo src={staticFile(clip.src)} startFrom={Math.round((clip.startSec ?? 0) * FPS)} playbackRate={rate} muted style={{ position: "absolute", left: 0, top: -CROP * fullH * u, width: w * u, height: fullH * u, objectFit: "cover" }} />
    </div>
  );
};

const PlayBeat: React.FC<{ cfg: PlayCfg; len: number; idx: number; total: number }> = ({ cfg, len, idx, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = useUnit();
  const WHIP = 7;
  const local = frame - WHIP;
  // speed: fit the whole clip into the beat; slow only for the tower (slow-mo), never faster than ×4
  const raw = cfg.clip.sec / (len / FPS);
  const rate = cfg.id === "play_tower" ? 0.5 : Math.max(0.7, Math.min(4, raw));
  const ff = rate > 1.15 ? Math.round(rate * 2) / 2 : rate < 0.9 ? rate : 1;
  const inK = interpolate(frame, [0, WHIP], [1, 0], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 3) });
  const outK = interpolate(local, [len - 4, len + 2], [0, 1], clamp);
  const x = inK * 1500 - outK * 1500;
  const combo = sp(frame, fps, WHIP, { damping: 8, stiffness: 320, mass: 0.4 });
  const hpFill = interpolate(local, [0, len], [idx / total, (idx + 1) / total], clamp);
  const moment = cfg.moment ? sp(frame, fps, WHIP + 20, { damping: 7, stiffness: 260, mass: 0.6 }) : 0;
  const H = 1000;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%) scale(4)", filter: "blur(16px) brightness(0.3) saturate(1.4)" }}>
          <Screen clip={cfg.clip} h={H} rate={rate} border={false} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 60% at 62% 50%, rgba(0,0,0,0) 30%, rgba(4,6,15,0.88) 100%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "relative", transform: `translateX(${(250 + x) * u}px) skewX(${-(inK - outK) * 8}deg)` }}>
          <Screen clip={cfg.clip} h={H} rate={rate} />
        </div>
      </AbsoluteFill>
      {/* top-left tag */}
      <AbsoluteFill style={{ padding: `${44 * u}px ${60 * u}px`, fontFamily: T.fontBody }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 * u, color: "#fff", fontWeight: 900, fontSize: 24 * u, letterSpacing: 3 * u }}>
          <span style={{ width: 16 * u, height: 16 * u, borderRadius: "50%", background: "#FF3B5C", boxShadow: "0 0 12px #FF3B5C", opacity: Math.floor(frame / 15) % 2 ? 1 : 0.4 }} />
          LIVE · MONAD TESTNET · REAL APP
        </div>
      </AbsoluteFill>
      {/* speed chip, top-right */}
      {ff !== 1 ? (
        <AbsoluteFill style={{ alignItems: "flex-end", padding: `${40 * u}px ${60 * u}px`, fontFamily: T.fontDisplay }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 * u, padding: `${8 * u}px ${20 * u}px`, borderRadius: 999, background: ff > 1 ? "rgba(20,241,149,0.16)" : "rgba(162,123,255,0.18)", boxShadow: `inset 0 0 0 ${3 * u}px ${ff > 1 ? "#14F195" : "#A27BFF"}`, color: "#fff", fontSize: 40 * u }}>
            {ff > 1 ? `⏩ ×${ff}` : `SLOW-MO ×${Math.round(rate * 10) / 10}`}
          </div>
        </AbsoluteFill>
      ) : null}
      {/* COMBO counter */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "flex-start", paddingLeft: 110 * u }}>
        <div style={{ transform: `scale(${0.6 + 0.4 * combo}) rotate(${(1 - combo) * -12}deg)`, transformOrigin: "0 50%", opacity: Math.min(1, combo * 1.4) * (1 - outK) }}>
          <div style={{ fontFamily: T.fontDisplay, fontSize: 64 * u, color: T.primaryHi, letterSpacing: 2 * u, lineHeight: 1 }}>COMBO</div>
          <div style={{ fontFamily: T.fontDisplay, fontSize: 230 * u, lineHeight: 0.9, backgroundImage: `linear-gradient(180deg, #fff 10%, ${T.primary} 60%, #B9741A)`, WebkitBackgroundClip: "text", color: "transparent", filter: `drop-shadow(0 ${8 * u}px ${30 * u}px ${withAlpha(T.primary, 0.6)})` }}>x{idx + 1}</div>
          <div style={{ fontFamily: T.fontDisplay, fontSize: 52 * u, color: "#fff", marginTop: 10 * u, textShadow: `0 ${4 * u}px 0 ${T.secondary}` }}>{cfg.combo}</div>
        </div>
      </AbsoluteFill>
      {/* big moment */}
      {cfg.moment ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: 120 * u }}>
          <div style={{ transform: `translateX(${-330 * u}px) scale(${moment}) rotate(${(1 - moment) * 8}deg)`, fontFamily: T.fontDisplay, fontSize: 120 * u, color: "#fff", textShadow: `0 ${8 * u}px 0 ${T.secondary}, 0 0 ${40 * u}px ${withAlpha(T.primary, 0.8)}`, opacity: 1 - outK }}>{cfg.moment}</div>
        </AbsoluteFill>
      ) : null}
      {/* stage bar */}
      <AbsoluteFill style={{ justifyContent: "flex-end", padding: `0 0 ${150 * u}px ${110 * u}px` }}>
        <div style={{ width: 640 * u, opacity: 1 - outK }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontFamily: T.fontDisplay, color: "#fff" }}>
            <span style={{ fontSize: 44 * u }}>{cfg.hud}</span>
            <span style={{ fontSize: 26 * u, color: T.textDim }}>STAGE {idx + 1}/{total}</span>
          </div>
          <div style={{ marginTop: 10 * u, height: 26 * u, borderRadius: 8 * u, background: "rgba(0,0,0,0.6)", boxShadow: `inset 0 0 0 ${3 * u}px ${withAlpha("#fff", 0.25)}`, overflow: "hidden", position: "relative" }}>
            <div style={{ position: "absolute", inset: 3 * u, width: `calc(${hpFill * 100}% - ${6 * u}px)`, borderRadius: 6 * u, background: `linear-gradient(90deg, #36E27B, ${T.primary})`, boxShadow: `0 0 ${16 * u}px ${withAlpha("#36E27B", 0.6)}` }} />
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const ProofWindow: React.FC<{ src: string; label: string; url?: string }> = ({ src, label, url }) => {
  const { u } = useUnit();
  const W = 980;
  return (
    <div style={{ position: "relative", width: W * u, borderRadius: 18 * u, overflow: "hidden", background: "#0e0f12", boxShadow: `0 ${40 * u}px ${100 * u}px rgba(0,0,0,0.65), 0 0 0 ${2 * u}px rgba(255,255,255,0.12)` }}>
      <div style={{ height: 52 * u, display: "flex", alignItems: "center", gap: 12 * u, padding: `0 ${18 * u}px`, background: "#1c1d22", fontFamily: T.fontBody }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((k) => <span key={k} style={{ width: 14 * u, height: 14 * u, borderRadius: "50%", background: k }} />)}
        <div style={{ marginLeft: 18 * u, flex: 1, height: 32 * u, borderRadius: 10 * u, background: "#2a2b31", display: "flex", alignItems: "center", padding: `0 ${14 * u}px`, color: "rgba(255,255,255,0.8)", fontSize: 19 * u, fontWeight: 600 }}>
          {url ?? "mempire-monad.vercel.app/proof · read live from the Monad testnet RPC"}
        </div>
      </div>
      <div style={{ position: "relative", height: 560 * u, overflow: "hidden" }}>
        <Img src={staticFile(src)} style={{ position: "absolute", left: 0, top: 0, width: W * u }} />
      </div>
      <div style={{ position: "absolute", left: 18 * u, bottom: 16 * u, padding: `${8 * u}px ${16 * u}px`, borderRadius: 999, background: "rgba(0,0,0,0.85)", color: "#fff", fontWeight: 800, fontSize: 22 * u, fontFamily: T.fontBody, boxShadow: `inset 0 0 0 ${2 * u}px rgba(20,241,149,0.7)` }}>
        <span style={{ color: "#14F195" }}>✓ Success</span> · {label}
      </div>
    </div>
  );
};

const Inventory: React.FC<{ unlocked: number; flashIdx: number; local: number }> = ({ unlocked, flashIdx, local }) => {
  const { u } = useUnit();
  return (
    <div style={{ display: "flex", gap: 14 * u, alignItems: "center" }}>
      {POWERS.map((p, i) => {
        const on = i < unlocked;
        const pop = i === flashIdx ? interpolate(local, [0, 6, 14], [1.7, 0.9, 1], clamp) : 1;
        const col = RARITY[p.rarity];
        return (
          <div key={p.id} style={{ width: 70 * u, height: 70 * u, borderRadius: 16 * u, background: on ? withAlpha(col, 0.22) : "rgba(255,255,255,0.05)", boxShadow: on ? `inset 0 0 0 ${3 * u}px ${col}, 0 0 ${18 * u}px ${withAlpha(col, 0.6)}` : `inset 0 0 0 ${2 * u}px rgba(255,255,255,0.15)`, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${pop})` }}>
            {on ? <Img src={staticFile(p.art)} style={{ width: 56 * u, height: 56 * u, objectFit: "contain" }} /> : <span style={{ color: "rgba(255,255,255,0.25)", fontFamily: T.fontDisplay, fontSize: 30 * u }}>?</span>}
          </div>
        );
      })}
      <div style={{ marginLeft: 16 * u, fontFamily: T.fontDisplay, fontSize: 46 * u, color: "#fff" }}>
        <span style={{ color: T.primary }}>{unlocked}</span>/{POWERS.length}
      </div>
    </div>
  );
};

const PowerBeat: React.FC<{ p: Power; idx: number; len: number }> = ({ p, idx, len }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = useUnit();
  const col = RARITY[p.rarity];
  const banner = sp(frame, fps, 0, { damping: 9, stiffness: 260, mass: 0.5 });
  const icon = sp(frame, fps, 5, { damping: 10, stiffness: 180, mass: 0.6 });
  const proof = sp(frame, fps, 14, { damping: 18, stiffness: 140 });
  const out = interpolate(frame, [len - 5, len], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: 1 - out }}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `translateX(${-470 * u}px)` }}>
        <div style={{ width: 1100 * u, height: 1100 * u, borderRadius: "50%", background: `repeating-conic-gradient(from ${frame * 1.2}deg, ${withAlpha(col, 0.22)} 0deg 8deg, rgba(0,0,0,0) 8deg 22deg)`, maskImage: "radial-gradient(circle, black 15%, transparent 62%)", opacity: icon }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "flex-start", paddingLeft: 120 * u, paddingTop: 70 * u }}>
        <div style={{ transform: `translateY(${(1 - banner) * -200 * u}px) scale(${0.8 + 0.2 * banner})`, opacity: banner, fontFamily: T.fontDisplay, lineHeight: 1 }}>
          <div style={{ fontSize: 34 * u, color: col, letterSpacing: 6 * u }}>{p.rarity} · POWER-UP {idx + 1}</div>
          <div style={{ fontSize: 86 * u, color: "#fff", textShadow: `0 ${6 * u}px 0 ${T.secondary}, 0 0 ${30 * u}px ${withAlpha(col, 0.6)}` }}>UNLOCKED!</div>
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `translate(${-470 * u}px, ${30 * u}px)` }}>
        <div style={{ width: 300 * u, height: 300 * u, clipPath: "polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0% 50%)", background: `radial-gradient(circle at 50% 40%, ${withAlpha(col, 0.55)}, ${withAlpha(T.bg2, 0.95)} 70%)`, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${icon}) rotate(${(1 - icon) * -90}deg)` }}>
          <Img src={staticFile(p.art)} style={{ width: 220 * u, height: 220 * u, objectFit: "contain", transform: `translateY(${Math.sin(frame / 10) * 5 * u}px)` }} />
        </div>
        <div style={{ marginTop: 24 * u, textAlign: "center", opacity: icon }}>
          <div style={{ fontFamily: T.fontDisplay, fontSize: 60 * u, color: "#fff" }}>{p.name}</div>
          <div style={{ fontFamily: T.fontBody, fontWeight: 800, fontSize: 30 * u, color: withAlpha("#fff", 0.82), marginTop: 6 * u }}>{p.line}</div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10 * u, marginTop: 14 * u, padding: `${8 * u}px ${18 * u}px`, borderRadius: 999, background: "rgba(20,241,149,0.14)", boxShadow: `inset 0 0 0 ${2 * u}px rgba(20,241,149,0.8)`, color: "#7CF5C0", fontFamily: T.fontBody, fontWeight: 800, fontSize: 24 * u }}>✓ live on Monad testnet</div>
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `translate(${400 * u}px, ${((1 - proof) * 700 + 20) * u}px)`, opacity: proof }}>
        <ProofWindow src={p.page} label={p.label} url={p.url} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const CHECK: [string, string][] = [
  ["art/cos/features/siws.webp", "Passkey account, no wallet"],
  ["art/cards", ""],
];
const ITEMS: { icon: string; text: string }[] = [
  { icon: "art/cos/features/siws.webp", text: "Passkey account, no wallet" },
  { icon: "art/chest_legendary.webp", text: "Staked battle, settled on Monad" },
  { icon: "art/cos/features/commit.webp", text: "Chainlink CRE market meta" },
  { icon: "art/chest_magic.webp", text: "Pyth-priced fighters" },
  { icon: "art/chest_golden.webp", text: "Gasless chest (EIP-7702)" },
  { icon: "art/chest_silver.webp", text: "AUSD on sign-up" },
  { icon: "art/clan_badge.webp", text: "Clan wars" },
];
void CHECK;
const Checklist: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = useUnit();
  const logo = sp(frame, fps, 0, { damping: 10, stiffness: 200, mass: 0.6 });
  return (
    <HorizonStage theme={T} arcY={0.92} intensity={0.9}>
      <AbsoluteFill style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 90 * u }}>
        <div style={{ transform: `scale(${logo})`, textAlign: "center" }}>
          <Img src={staticFile("mm/logo.webp")} style={{ width: 640 * u }} />
          <div style={{ fontFamily: T.fontDisplay, fontSize: 64 * u, color: "#fff", textShadow: `0 ${6 * u}px 0 ${T.secondary}` }}>LOADING THE EMPIRE…</div>
          <div style={{ fontFamily: T.fontBody, fontWeight: 900, fontSize: 28 * u, letterSpacing: 5 * u, color: T.primary, marginTop: 8 * u }}>MONAD TESTNET · CHAIN 10143</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 * u }}>
          {ITEMS.map((it, i) => {
            const at = 18 + i * 26;
            const k = sp(frame, fps, at, { damping: 14, stiffness: 220 });
            const ready = frame > at + 18;
            return (
              <div key={it.text} style={{ display: "flex", alignItems: "center", gap: 18 * u, padding: `${12 * u}px ${24 * u}px`, borderRadius: 18 * u, background: "rgba(10,16,40,0.78)", boxShadow: `inset 0 0 0 ${2 * u}px ${ready ? "rgba(20,241,149,0.6)" : "rgba(255,255,255,0.15)"}`, transform: `translateX(${(1 - k) * 160 * u}px)`, opacity: k, width: 720 * u }}>
                <Img src={staticFile(it.icon)} style={{ width: 54 * u, height: 54 * u, objectFit: "contain" }} />
                <span style={{ fontFamily: T.fontDisplay, fontSize: 36 * u, color: "#fff", flex: 1 }}>{it.text}</span>
                <span style={{ fontFamily: T.fontBody, fontWeight: 900, fontSize: 26 * u, color: ready ? "#14F195" : T.textDim }}>{ready ? "READY ✓" : "SETTING UP…"}</span>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </HorizonStage>
  );
};

const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = useUnit();
  const k = sp(frame, fps, 0, { damping: 8, stiffness: 240, mass: 0.6 });
  return (
    <HorizonStage theme={T} arcY={0.86} intensity={1}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontFamily: T.fontDisplay, fontSize: 150 * u, color: "#fff", transform: `scale(${k})`, textShadow: `0 ${10 * u}px 0 ${T.secondary}, 0 0 ${50 * u}px ${withAlpha(T.primary, 0.6)}` }}>EVERY COIN IS A FIGHTER</div>
        <div style={{ fontFamily: T.fontBody, fontWeight: 900, fontSize: 36 * u, letterSpacing: 8 * u, color: T.primary, opacity: k }}>STAKE · BATTLE · SETTLE ON MONAD</div>
      </AbsoluteFill>
    </HorizonStage>
  );
};

const HowStage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = useUnit();
  const rel = (s: Seg) => s.start - HOW_INTRO[0].start;
  const unlocked = HOW_SEGS.filter((s) => frame >= rel(s)).length;
  const curIdx = HOW_SEGS.findIndex((s) => frame >= rel(s) && frame < rel(s) + s.len);
  const intro = HOW_INTRO[0];
  const allRel = ALL.start - intro.start;
  return (
    <Shake impacts={HOW_SEGS.map(rel)} amp={12}>
      <HorizonStage theme={T} arcY={0.9} intensity={0.9}>
        <Sequence durationInFrames={intro.len}>
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontFamily: T.fontDisplay, fontSize: 110 * u, color: "#fff", opacity: sp(frame, fps, 0), textShadow: `0 ${8 * u}px 0 ${T.secondary}` }}>WHAT'S LIVE ON MONAD?</div>
            <div style={{ fontFamily: T.fontBody, fontWeight: 900, fontSize: 34 * u, letterSpacing: 6 * u, color: T.primary, marginTop: 10 * u }}>UNLOCKING POWER-UPS…</div>
          </AbsoluteFill>
        </Sequence>
        {HOW_SEGS.map((s, i) => (
          <Sequence key={s.id} from={rel(s)} durationInFrames={s.len} name={s.id}>
            <PowerBeat p={POWERS[i]} idx={i} len={s.len} />
          </Sequence>
        ))}
        <Sequence from={allRel} durationInFrames={ALL.len}>
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontFamily: T.fontDisplay, fontSize: 120 * u, color: "#fff", transform: `scale(${0.7 + 0.3 * sp(frame - allRel, fps, 0, { damping: 10 })})` }}>
              <span style={{ color: T.primary }}>{POWERS.length}/{POWERS.length}</span> POWER-UPS
            </div>
            <div style={{ fontFamily: T.fontBody, fontWeight: 900, fontSize: 40 * u, letterSpacing: 6 * u, color: "#7CF5C0", marginTop: 16 * u }}>ALL LIVE ON MONAD TESTNET</div>
          </AbsoluteFill>
        </Sequence>
        <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-end", padding: `${56 * u}px ${70 * u}px 0 0` }}>
          <Inventory unlocked={unlocked} flashIdx={curIdx} local={curIdx >= 0 ? frame - rel(HOW_SEGS[curIdx]) : 99} />
        </AbsoluteFill>
      </HorizonStage>
    </Shake>
  );
};

const OutroCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u } = useUnit();
  const logo = sp(frame, fps, 0, { damping: 9, stiffness: 200, mass: 0.6 });
  const tag = sp(frame, fps, 18, { damping: 12 });
  const url = sp(frame, fps, 34, { damping: 12 });
  return (
    <HorizonStage theme={T} arcY={0.86} intensity={1}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <Img src={staticFile("mm/logo.webp")} style={{ width: 820 * u, transform: `scale(${logo})` }} />
        <div style={{ fontFamily: T.fontDisplay, fontSize: 92 * u, color: "#fff", opacity: tag, textShadow: `0 ${8 * u}px 0 ${T.secondary}` }}>Every coin is a fighter.</div>
        <div style={{ marginTop: 30 * u, padding: `${14 * u}px ${40 * u}px`, borderRadius: 999, background: T.primary, color: "#1b1030", fontFamily: T.fontDisplay, fontSize: 58 * u, opacity: url, transform: `scale(${0.8 + 0.2 * url})` }}>mempire-monad.vercel.app</div>
        <div style={{ marginTop: 22 * u, fontFamily: T.fontBody, fontWeight: 800, fontSize: 28 * u, color: T.textDim, opacity: url }}>Live on Monad testnet · Mera passkeys · Chainlink CRE · Pyth · Agora AUSD</div>
      </AbsoluteFill>
    </HorizonStage>
  );
};

// ---------------------------------------------------------------- the film
export const MempireMonadFilm: React.FC = () => {
  const frame = useCurrentFrame();
  const flashes = [PLAY_START, ...PLAY_SEGS.map((s) => s.start), HOW_START, ALL.start, OUTRO.start];
  const unlockSfx = HOW_SEGS.map((s) => s.start + 4);
  const whooshes = [PLAY_START - 3, ...PLAY_SEGS.map((s) => s.start - 3), HOW_START - 3, OUTRO.start - 3];
  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <Fonts />
      <Sequence durationInFrames={INTRO} name="checklist"><Checklist /></Sequence>
      <Sequence from={INTRO} durationInFrames={TITLE} name="title"><TitleCard /></Sequence>
      <Shake impacts={PLAY_SEGS.map((s) => s.start)} amp={14}>
        <AbsoluteFill style={{ background: "transparent" }}>
          {PLAY_SEGS.map((s, i) => (
            <Sequence key={s.id} from={Math.max(0, s.start - 7)} durationInFrames={s.len + 10} name={s.id}>
              <PlayBeat cfg={PLAY[i]} len={s.len} idx={i} total={PLAY.length} />
            </Sequence>
          ))}
        </AbsoluteFill>
      </Shake>
      <Sequence from={HOW_START} durationInFrames={ALL.start + ALL.len - HOW_START} name="how"><HowStage /></Sequence>
      <Sequence from={OUTRO.start} durationInFrames={OUTRO.len} name="outro"><OutroCard /></Sequence>
      {flashes.map((f) => <Flash key={f} at={f} />)}
      <Grain opacity={0.05} />
      <Subtitles theme={T} cues={CUES} />
      {/* audio: the Mempire score, ducked under the voice; one VO file per beat; unlock + whoosh SFX */}
      <Audio src={staticFile("films/mempire/audio/music-eleven.mp3")} volume={(f) => 0.36 * (voiceOn(f) ? 0.32 : 1) * interpolate(f, [0, 15, MONAD_TOTAL - 45, MONAD_TOTAL], [0, 1, 1, 0], clamp)} />
      {ALL_VO.map((s) => (
        <Sequence key={s.id} from={s.vo} durationInFrames={vf(s.id) + 8}><Audio src={staticFile(VOS[s.id].file)} /></Sequence>
      ))}
      {unlockSfx.map((f) => <Sequence key={`u${f}`} from={f} durationInFrames={20}><Audio src={staticFile("mm/sfx/unlock.wav")} volume={0.6} /></Sequence>)}
      {whooshes.map((f) => <Sequence key={`w${f}`} from={Math.max(0, f)} durationInFrames={15}><Audio src={staticFile("mm/sfx/whoosh.wav")} volume={0.5} /></Sequence>)}
      <span style={{ display: "none" }}>{frame}</span>
    </AbsoluteFill>
  );
};
