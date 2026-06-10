# Online Net Debug Notes

This file records the temporary online-diagnostics layer for the multiplayer tennis prototype.

## Why this exists

The single-player build feels responsive because input, movement, ball simulation, and hit detection all happen locally in the same frame.

The online build is server-authoritative:

1. The browser sends player input through WebSocket.
2. The server simulates player movement, ball movement, and hit detection.
3. The server broadcasts snapshots back to both players.
4. The browser renders the latest server snapshot.

That means network latency and snapshot cadence can make an online hit feel stricter than the same local hit. The player may see the ball as reachable, while the server has already advanced the ball or still has the player slightly behind.

## Debug entry point

Use this only while diagnosing online play:

```text
https://pixel-tennis-web.onrender.com/?mode=online&room=ROOM1&debug=net
```

Normal players should use links without `debug=net`.

## Current implementation

The debug UI is isolated in `net-debug.js`, which is loaded dynamically only when `debug=net` is present.

The main game keeps only small hooks:

- include `debug: true` in the online join message
- send a periodic ping through the existing WebSocket
- forward pong/state/debug packets to the optional debug module
- ask the optional module to draw its small overlay

The server keeps lightweight instrumentation:

- `serverTime` in state packets
- `ping` -> `pong`
- miss reason events for debug clients only

## What to look at

Focus on the local player's window. If testing as P1, use the P1 browser tab and ignore P2's debug summary.

Useful console call:

```js
PixelTennisDebug.summary()
```

Important fields:

- `rttMs`: rough round-trip time from browser to server and back.
- `total`: recent local-player miss count, capped at 100.
- `byCode`: miss reasons grouped by code.
- `avg.dx`, `avg.dy`, `avg.z`: average miss geometry.
- `latest`: most recent miss event.

Common miss codes:

- `x_far`: player was too far left/right from the ball.
- `y_far`: player was too far forward/back from the ball.
- `too_high`: ball was above racket reach.
- `too_low`: ball was already too low.
- `wrong_side`: the hit arrived while the ball was still on the other side.
- `cooldown`: player tried to swing during hit cooldown.
- `ball_idle`: ball was not in play.

## How this should guide tuning

If `x_far` and `y_far` dominate:

- Online movement may need latency compensation.
- Candidate fixes: online-only hit radius buffer, online-only input buffering, slightly higher online acceleration, or local prediction.

If `too_high` or `too_low` dominates:

- The vertical hit window is too strict for online timing.
- Candidate fixes: online-only `reachZ` buffer or larger hit input buffer.

If `wrong_side` dominates:

- Swing inputs are arriving early relative to server ball state.
- Candidate fixes: retain swing intent longer on the server or allow a small pre-hit grace window.

If `cooldown` dominates:

- Players are double-tapping or the hit cooldown is too punishing online.
- Candidate fixes: online-only cooldown reduction or clearer swing feedback.

## Removal plan

For a production-clean build, delete:

- `net-debug.js`
- this document
- `DEBUG_NET`, `loadNetDebugModule`, and the `netDebug` hook calls in `game.js`
- debug-only `ping`, `pong`, `serverTime`, and miss-event code in `server/multiplayer-server.js` if no longer needed

Because the front-end diagnostics live in a separate file and load only with `debug=net`, normal game payload impact stays small.
