# Pixel Tennis Web Prototype

A portrait-first web prototype for the retro tennis game. It is a static Canvas app and can be served from any local web server.

Live site: https://evalee101010.github.io/pixel-tennis-web/

## Run

```sh
python3 -m http.server 4173
```

Open `http://localhost:4173/`.

## Online Multiplayer Prototype

Single-player stays as the default static page. To try the online room prototype locally, run the WebSocket room server:

```sh
node server/multiplayer-server.js
```

Open `http://localhost:8787/?mode=online` to create a room, then share the room code or URL with a second browser/tab:

```text
http://localhost:8787/?mode=online&room=ABCD
```

The room server owns movement, ball physics, scoring, match result, replay, and theme sync. P1 uses the default court view. P2 uses a mirrored local view, so each player sees themselves at the bottom while the server keeps one shared P1/P2 world state.

## Deploy

See `DEPLOY.md`. The project is static and can be published from the repository root with no build command.

## Desktop Controls

- Move: `WASD` or arrow keys
- Hit: `Space` or `Enter`
- Lob: hold up while hitting
- Drop shot: hold down while hitting
- Special: `E` when the energy bar is full
- Reset: `R`
- Pause: `P`

The on-canvas stick and hit buttons already accept pointer input, so the mobile version can reuse the same gameplay loop.

## Tuning

Core values live in `TUNING` at the top of `game.js`.

- `player`: movement, reach, cooldown
- `ai`: reaction, speed, fail rate
- `ball`: gravity, bounce, floor drag
- `shots`: travel time, height, error, energy gain
- `match`: game length and point pacing

Use `window.PixelTennis.snapshot()` in the browser console to inspect the current state.

## Replaceable Assets

- Backgrounds: `assets/backgrounds/`
- Character bodies: `assets/characters/`
- Equipment: `assets/equipment/`
- Themed UI: `assets/ui/<theme>/`

The render order is background theme, court layer, themed net, ball and character layer, then UI. Backgrounds, character bodies, and themed controls are loaded as separate image assets so they can be swapped without changing gameplay code.
