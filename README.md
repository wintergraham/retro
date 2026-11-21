# 8-Bit Chip Squad

A party game for up to 3 phones and one big screen. The laptop/TV (**host**) plays an original
60-second chiptune through a 4-voice WebAudio chip synth and shows a QR code. Each phone that
joins *is* one NES-style channel and plays its own mini-game in time with the song (the fourth
voice, the Pulse 2 arpeggio, is always played by the CPU):

| Channel | Wave | Game |
| --- | --- | --- |
| LEAD | Pulse 1 | Piano Tiles: tap the falling tiles on the line |
| BASS | Triangle | Tilt Ship: tilt (or drag) to ride the bassline; drifting bends the bass out of tune |
| DRUMS | Noise | Timing Rings: smash KICK / SNARE / TOM as the rings close |

After the host picks a song, every phone shows an instruction card with a big READY button (plus
calibration and, for bass on iPhone, the tilt permission). The song counts in once everyone's
ready, or when the host hits START ANYWAY.

Misses are meant to be heard: your channel goes sour, stutters or cuts out and crunches through a
bitcrusher for about a beat, and the screen glitches and shakes. Team health drives the whole
mix: as it falls, the music picks up drive, bitcrush, a closing lowpass, tape warble and (under
30 HP) split-second dropouts, and the CRT picture warps further. The host shows each player's live
accuracy and miss streak, and tags whoever's missed most in the last 8 seconds as the WEAKEST
LINK (their phone is told too). Hit zero and it's game over; survive and you get an S–F rank plus
awards. Empty channels are played by the CPU.

## Playing (the normal way)

1. On a laptop or TV, open **https://chip-squad.onrender.com/host**. If it takes a minute to load,
   that's the free server waking up; just wait.
2. Everyone scans the QR code with their phone (or opens the site and types the 4-letter room code).
3. Each phone picks a channel (LEAD, BASS or DRUMS). Hit **CALIB** once per phone and tap along
   to the clicks so your taps line up with the speaker.
4. Pick a song on the big screen (▲▼ or click), press START, then everyone hits READY.

Tips: turn the laptop volume up, turn off the iPhone silent switch if you want phone sounds, and
open the host page a few minutes before people arrive so the server is awake.

## Setting up your own server (Render, free)

Only needed if the link above is down or you want your own copy.

1. Make a free account at [render.com](https://render.com) and sign in with GitHub.
2. Fork this repo to your own GitHub account (the **Fork** button on GitHub).
3. In Render, click **New → Blueprint**, pick your fork and click **Apply**. It reads
   `render.yaml` and sets everything up (build `npm ci && npm run build`, start `npm start`).
4. Wait for the first build (a few minutes). Your game is at
   `https://<your-service-name>.onrender.com/host`.

After that, every push to `main` redeploys automatically.

### If something breaks

- **Page won't load / spins forever:** the free server was asleep. Wait up to a minute and refresh.
- **Everyone got kicked out:** a redeploy or server restart ends every room. Refresh the host page
  to make a new room and rejoin with the new code.
- **Still broken:** in the Render dashboard open the service and click **Manual Deploy → Clear
  build cache & deploy**. Check the **Logs** tab for errors.
- **Taps feel late or early:** redo CALIB on that phone. If the whole room is off (TV or Bluetooth
  speaker), nudge **SPEAKER DELAY** on the host lobby.
- **Tilt doesn't work on iPhone:** the page has to be on `https://`, and you need to tap allow on
  the motion permission prompt. Reloading the page can lose that permission, so rejoin and allow it again.

## Running it on your own computer

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
git clone https://github.com/wintergraham/retro.git
cd retro
npm install
npm run dev
```

Open **https://localhost:5173/host** on the laptop and accept the certificate warning. Phones must
be on the same wifi: scan the QR code, accept the certificate warning, and join. HTTPS is needed
even locally because tilt controls only work in a secure context.

To run the production build yourself:

```sh
npm run build && npm start   # serves the game and the WebSocket on $PORT (default 3001)
```

Put HTTPS in front of it (a tunnel, a reverse proxy or a host like Render) or iPhones won't allow tilt.

## Sound and timing

- Phones play quiet click/crunch SFX of their own (toggle in the lobby). On iPhone the silent
  switch mutes web audio, so flip it off if you want them.
- **CALIBRATE** on a phone makes the host click 8 times; tap along and the phone stores the
  median offset (`inputOffset` in localStorage). It covers speaker, Bluetooth, touch and device
  delay in one go, so do it once per phone/speaker setup.
- If the host's speakers are late in a way the browser can't see (TV, soundbar, Bluetooth), use
  the **SPEAKER DELAY** nudge on the host lobby.

## Deploy notes (Render)

- Free services spin down after ~15 minutes without traffic; the first request after that is a
  cold start that can take up to a minute.
- Rooms live in server memory, so a restart, redeploy or spin-down ends every open room.

## How it works

- `server/index.ts`: tiny Node + `ws` relay. Rooms, channel seats, clock `ping`/`pong`, and it
  forwards phone judgements to the host. Serves `dist/` in production.
- `shared/`: the protocol and the songs. Songs are written in a compact text notation and
  compiled into timed charts that both the synth and the mini-games read.
- `src/net.ts`: WebSocket plus NTP-style clock sync, so every device agrees on when the song
  started without streaming audio.
- `src/host/`: the chip synth, scoring and the TV UI. Judgements arrive from phones; misses wreck
  that channel for a beat, the bass player's drift bends the triangle, and health degrades the mix.
- `src/phone/`: the three canvas mini-games. Phones judge their own taps locally against the
  synced clock and only send `perfect`/`good`/`miss`. Shared bits (judging, popups, screen FX
  hooks) live in `games/common.ts`.
- `src/fx/`: the WebGL CRT pass (curvature, scanlines, chromatic aberration, glitch, flash) and
  the shake/glitch/flash envelopes. Phones run it over the game canvas, the host as an overlay.
  Without WebGL it falls back to CSS scanlines; `prefers-reduced-motion` turns shake off.
