# 8-Bit Chip Squad

A party game for up to 4 phones and one big screen. The laptop/TV (**host**) plays an original
60-second chiptune through a 4-channel WebAudio chip synth and shows a QR code. Each phone that
joins *is* one NES-style channel and plays its own mini-game in time with the song:

| Channel | Wave | Game |
| --- | --- | --- |
| LEAD | Pulse 1 | Piano Tiles: tap the falling tiles on the line |
| BASS | Triangle | Tilt Ship: tilt (or drag) to ride the bassline; drifting bends the bass out of tune |
| DRUMS | Noise | Timing Rings: smash KICK / SNARE / TOM as the rings close |
| ARP | Pulse 2 | Connect Dots: swipe the numbered dots in order before the bar ends |

Misses make your channel drop out of the mix and drain the team health bar. Hit zero and it's
game over; survive and you get an S–F rank plus awards. Empty channels are played by the CPU.

## Run it

```sh
npm install
npm run dev
```

Open **https://localhost:5173/host** on the laptop and accept the self-signed certificate. Phones
must be on the same wifi: scan the QR code, accept the certificate warning, and join. HTTPS is
needed even in dev because tilt controls and screen wake lock only work in a secure context.

Production build:

```sh
npm run build && npm start   # serves dist/ and the WebSocket on $PORT (default 3001)
```

Put HTTPS in front of it (a reverse proxy, a tunnel, or a host like Render) or iPhones won't
allow tilt.

## Sound and timing

- Phones play quiet click/crunch SFX of their own (toggle in the lobby). On iPhone the silent
  switch mutes web audio, so flip it off if you want them.
- **CALIBRATE** on a phone makes the host click 8 times; tap along and the phone stores the
  median offset (`inputOffset` in localStorage). It covers speaker, Bluetooth, touch and device
  delay in one go, so do it once per phone/speaker setup.
- If the host's speakers are late in a way the browser can't see (TV, soundbar, Bluetooth), use
  the **SPEAKER DELAY** nudge on the host lobby.

## Deploy (Render)

`render.yaml` defines a free Node web service in Frankfurt (`npm ci && npm run build`, then
`npm start`, health check `/api/info`). Render provides HTTPS and sets `PORT`.

- Free services spin down after ~15 minutes without traffic; the first request after that is a
  cold start that can take up to a minute. Open the host page a bit before people arrive.
- Rooms live in server memory, so a restart, redeploy or spin-down ends every open room.

## How it works

- `server/index.ts`: tiny Node + `ws` relay. Rooms, channel seats, clock `ping`/`pong`, and it
  forwards phone judgements to the host. Serves `dist/` in production.
- `shared/`: the protocol and the songs. Songs are written in a compact text notation and
  compiled into timed charts that both the synth and the mini-games read.
- `src/net.ts`: WebSocket plus NTP-style clock sync, so every device agrees on when the song
  started without streaming audio.
- `src/host/`: the chip synth, scoring and the TV UI. Judgements arrive from phones; misses duck
  that channel and the bass player's drift bends the triangle.
- `src/phone/`: the four canvas mini-games. Phones judge their own taps locally against the
  synced clock and only send `perfect`/`good`/`miss`.
