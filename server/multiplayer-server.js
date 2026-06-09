#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const TICK_MS = 1000 / 60;
const BROADCAST_MS = 1000 / 24;

const WORLD = {
  xMin: -5.2,
  xMax: 5.2,
  p1YMin: 1.15,
  p1YMax: 11.55,
  p2YMin: -11.55,
  p2YMax: -1.15,
  singlesX: 4.115,
  baselineY: 11.885,
  netHeight: 0.95,
};

const PLAYER = {
  speed: 5.95,
  accel: 21,
  friction: 27,
  hitRadiusX: 1.08,
  hitRadiusY: 1.22,
  reachZ: 2.85,
  hitCooldown: 0.36,
  perfectRadius: 0.34,
  goodRadius: 0.78,
};

const BALL = {
  gravity: 22,
  bounce: 0.68,
  floorDrag: 0.7,
};

const SHOTS = {
  normal: { kind: "normal", time: 1.02, height: 2.6, error: 0.34, energy: 10 },
  power: { kind: "power", time: 0.8, height: 2.0, error: 0.48, energy: 14 },
  lob: { kind: "lob", time: 1.48, height: 6.0, error: 0.42, energy: 12 },
  drop: { kind: "drop", time: 0.72, height: 1.35, error: 0.5, energy: 13 },
  special: { kind: "special", time: 0.66, height: 1.8, error: 0.14, energy: 0 },
  serve: { kind: "serve", time: 0.96, height: 2.85, error: 0.22, energy: 0 },
};

const rooms = new Map();
const connections = new Set();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function chance(amount) {
  return Math.random() < amount;
}

function emptyInput() {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    hit: false,
    special: false,
    aim: 0,
    shotUp: false,
    shotDown: false,
  };
}

function makePlayer(id) {
  const isP1 = id === "p1";
  return {
    id,
    x: 0,
    y: isP1 ? 9.9 : -9.9,
    vx: 0,
    vy: 0,
    cooldown: 0,
    energy: 0,
    connected: false,
  };
}

function makeBall() {
  return {
    x: 0,
    y: -9,
    z: 1,
    vx: 0,
    vy: 0,
    vz: 0,
    bounceCount: 0,
    inPlay: false,
    lastY: -9,
  };
}

function makeRoom(id) {
  const room = {
    id,
    clients: new Map(),
    players: {
      p1: makePlayer("p1"),
      p2: makePlayer("p2"),
    },
    inputs: {
      p1: emptyInput(),
      p2: emptyInput(),
    },
    ball: makeBall(),
    phase: "waiting",
    timer: 0,
    message: "WAITING FOR PLAYER 2",
    messageSub: "",
    server: "p1",
    lastHit: "p2",
    pointWinner: null,
    rallyHits: 0,
    maxRally: 0,
    playerPoints: 0,
    aiPoints: 0,
    playerGames: 0,
    aiGames: 0,
    gamesToWin: 3,
    themeIndex: 0,
    result: null,
    lastBroadcast: 0,
  };
  placeBallForServe(room);
  rooms.set(id, room);
  return room;
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) {
      code += alphabet[(Math.random() * alphabet.length) | 0];
    }
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function normalizeRoom(input) {
  return String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function assignPlayer(room, client) {
  if (!room.clients.has("p1")) return "p1";
  if (!room.clients.has("p2")) return "p2";
  return `spectator-${client.id.slice(0, 4)}`;
}

function joinRoom(client, requestedRoom) {
  if (client.room) leaveRoom(client);
  const id = normalizeRoom(requestedRoom) || roomCode();
  const room = rooms.get(id) || makeRoom(id);
  const playerId = assignPlayer(room, client);
  client.room = room;
  client.playerId = playerId;
  room.clients.set(playerId, client);
  if (playerId === "p1" || playerId === "p2") {
    room.players[playerId].connected = true;
  }
  sendJson(client, {
    type: "welcome",
    room: room.id,
    playerId,
    role: playerId.startsWith("spectator") ? "spectator" : "player",
  });
  syncRoomReadiness(room);
  broadcastRoom(room);
}

function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.playerId);
  if (client.playerId === "p1" || client.playerId === "p2") {
    room.players[client.playerId].connected = false;
    room.inputs[client.playerId] = emptyInput();
  }
  client.room = null;
  client.playerId = null;
  if (room.clients.size === 0) {
    rooms.delete(room.id);
    return;
  }
  syncRoomReadiness(room);
  broadcastRoom(room);
}

function syncRoomReadiness(room) {
  const ready = room.players.p1.connected && room.players.p2.connected;
  if (!ready) {
    room.phase = "waiting";
    room.timer = 0;
    room.message = room.players.p1.connected ? "WAITING FOR PLAYER 2" : "WAITING FOR PLAYER 1";
    room.messageSub = `ROOM ${room.id}`;
    room.ball.inPlay = false;
    placeBallForServe(room);
    return;
  }
  if (room.phase === "waiting") {
    resetMatch(room, false);
    room.messageSub = `ROOM ${room.id}`;
  }
}

function resetMatch(room, keepTheme = true) {
  const themeIndex = room.themeIndex;
  room.players.p1 = makePlayer("p1");
  room.players.p2 = makePlayer("p2");
  room.players.p1.connected = room.clients.has("p1");
  room.players.p2.connected = room.clients.has("p2");
  room.inputs.p1 = emptyInput();
  room.inputs.p2 = emptyInput();
  room.ball = makeBall();
  room.phase = "serveWait";
  room.timer = 0.9;
  room.message = "PLAYER 1 SERVE";
  room.messageSub = `ROOM ${room.id}`;
  room.server = "p1";
  room.lastHit = "p2";
  room.pointWinner = null;
  room.rallyHits = 0;
  room.maxRally = 0;
  room.playerPoints = 0;
  room.aiPoints = 0;
  room.playerGames = 0;
  room.aiGames = 0;
  room.result = null;
  room.themeIndex = keepTheme ? themeIndex : room.themeIndex;
  placeBallForServe(room);
}

function startNextPoint(room) {
  room.phase = "serveWait";
  room.timer = 0.9;
  room.message = `${room.server === "p1" ? "PLAYER 1" : "PLAYER 2"} SERVE`;
  room.messageSub = `ROOM ${room.id}`;
  room.rallyHits = 0;
  room.pointWinner = null;
  placeBallForServe(room);
}

function placeBallForServe(room) {
  const server = room.players[room.server] || room.players.p1;
  const isP1 = room.server === "p1";
  room.ball.x = server.x + (isP1 ? -0.25 : 0.25);
  room.ball.y = isP1 ? 10.2 : -10.2;
  room.ball.z = 1;
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.ball.vz = 0;
  room.ball.bounceCount = 0;
  room.ball.inPlay = false;
  room.ball.lastY = room.ball.y;
}

function serve(room) {
  placeBallForServe(room);
  room.ball.inPlay = true;
  room.phase = "rally";
  room.message = "";
  room.messageSub = `ROOM ${room.id}`;
  room.rallyHits = 0;
  room.lastHit = room.server;
  const target = room.server === "p1"
    ? { x: rand(-2.7, 2.7), y: rand(-7.6, -5.1) }
    : { x: rand(-2.7, 2.7), y: rand(5.1, 7.6) };
  launchBallTo(room, target.x, target.y, SHOTS.serve, 1);
}

function updateRoom(room, dt, now) {
  if (!room.players.p1.connected || !room.players.p2.connected) {
    syncRoomReadiness(room);
    return;
  }
  updatePlayer(room.players.p1, room.inputs.p1, 1, dt);
  updatePlayer(room.players.p2, room.inputs.p2, -1, dt);
  room.players.p1.cooldown = Math.max(0, room.players.p1.cooldown - dt);
  room.players.p2.cooldown = Math.max(0, room.players.p2.cooldown - dt);

  if (room.phase === "serveWait") {
    room.timer -= dt;
    placeBallForServe(room);
    if (room.timer <= 0) serve(room);
  } else if (room.phase === "rally") {
    updateBall(room, dt);
    tryControlledHit(room, "p1", 1);
    tryControlledHit(room, "p2", -1);
  } else if (room.phase === "pointOver") {
    room.timer -= dt;
    if (room.timer <= 0) startNextPoint(room);
  }

  if (now - room.lastBroadcast >= BROADCAST_MS) {
    broadcastRoom(room);
    room.lastBroadcast = now;
  }
}

function updatePlayer(player, input, side, dt) {
  let ix = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let iy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const mag = Math.hypot(ix, iy);
  if (mag > 1) {
    ix /= mag;
    iy /= mag;
  }
  if (ix || iy) {
    player.vx += ix * PLAYER.accel * dt;
    player.vy += iy * PLAYER.accel * dt;
  } else {
    const v = Math.hypot(player.vx, player.vy);
    if (v > 0) {
      const next = Math.max(0, v - PLAYER.friction * dt);
      player.vx *= next / v;
      player.vy *= next / v;
    }
  }
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > PLAYER.speed) {
    player.vx = (player.vx / speed) * PLAYER.speed;
    player.vy = (player.vy / speed) * PLAYER.speed;
  }
  player.x = clamp(player.x + player.vx * dt, -4.55, 4.55);
  player.y = clamp(
    player.y + player.vy * dt,
    side > 0 ? WORLD.p1YMin : WORLD.p2YMin,
    side > 0 ? WORLD.p1YMax : WORLD.p2YMax,
  );
}

function updateBall(room, dt) {
  const ball = room.ball;
  ball.lastY = ball.y;
  ball.vz -= BALL.gravity * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  if ((ball.lastY < 0 && ball.y >= 0) || (ball.lastY > 0 && ball.y <= 0)) {
    if (ball.z < WORLD.netHeight) {
      endPoint(room, opponentOf(room.lastHit), "NET");
      return;
    }
  }

  if (Math.abs(ball.x) > WORLD.xMax + 1.4 || Math.abs(ball.y) > 13.4 + 1.6) {
    const winner = ball.bounceCount > 0 ? room.lastHit : opponentOf(room.lastHit);
    endPoint(room, winner, ball.bounceCount > 0 ? "DOUBLE BOUNCE" : "OUT");
    return;
  }

  if (ball.z <= 0) {
    ball.z = 0;
    onBallBounce(room);
  }
}

function onBallBounce(room) {
  const ball = room.ball;
  ball.bounceCount += 1;
  if (ball.bounceCount === 1) {
    const expectedSide = room.lastHit === "p1" ? -1 : 1;
    if (!isLegalBounce(ball, expectedSide)) {
      endPoint(room, opponentOf(room.lastHit), "OUT");
      return;
    }
  } else {
    endPoint(room, room.lastHit, "DOUBLE BOUNCE");
    return;
  }
  ball.vz = Math.max(2.1, -ball.vz * BALL.bounce);
  ball.vx *= BALL.floorDrag;
  ball.vy *= BALL.floorDrag;
}

function isLegalBounce(ball, expectedSide) {
  const sideOk = expectedSide < 0 ? ball.y < -0.08 : ball.y > 0.08;
  const xOk = Math.abs(ball.x) <= WORLD.singlesX + 0.04;
  const yOk = Math.abs(ball.y) <= WORLD.baselineY + 0.05;
  return sideOk && xOk && yOk;
}

function tryControlledHit(room, playerId, side) {
  const actor = room.players[playerId];
  const input = room.inputs[playerId];
  if ((!input.hit && !input.special) || actor.cooldown > 0) return;
  if (!canHit(room, actor, playerId, side)) return;

  const quality = hitQuality(room.ball, actor);
  const useSpecial = input.special && actor.energy >= 100;
  const shot = chooseShot(input, useSpecial);
  const targetX = chooseTargetX(room, playerId, input, shot);
  const targetY = chooseTargetY(side, shot);
  const errorScale = quality === "perfect" ? 0.32 : quality === "good" ? 0.78 : 1.38;
  const finalX = clamp(targetX + rand(-shot.error, shot.error) * errorScale, -4.02, 4.02);
  const finalY = clamp(targetY + rand(-shot.error, shot.error) * errorScale, -11.45, 11.45);

  room.lastHit = playerId;
  room.rallyHits += 1;
  room.maxRally = Math.max(room.maxRally, room.rallyHits);
  room.ball.bounceCount = 0;
  launchBallTo(room, finalX, finalY, shot, quality === "late" ? 0.92 : 1);
  actor.cooldown = PLAYER.hitCooldown;
  if (useSpecial) {
    actor.energy = 0;
  } else {
    actor.energy = clamp(actor.energy + shot.energy + (quality === "perfect" ? 8 : quality === "good" ? 3 : 0), 0, 100);
  }
}

function canHit(room, actor, playerId, side) {
  const ball = room.ball;
  if (!ball.inPlay) return false;
  if (room.lastHit === playerId) return false;
  if (side > 0 && ball.y < 0.1) return false;
  if (side < 0 && ball.y > -0.1) return false;
  if (ball.z > PLAYER.reachZ || ball.z < 0.02) return false;
  return Math.abs(ball.x - actor.x) <= PLAYER.hitRadiusX && Math.abs(ball.y - actor.y) <= PLAYER.hitRadiusY;
}

function hitQuality(ball, actor) {
  const dx = Math.abs(ball.x - actor.x) / PLAYER.hitRadiusX;
  const dy = Math.abs(ball.y - actor.y) / PLAYER.hitRadiusY;
  const d = Math.hypot(dx, dy);
  if (d < PLAYER.perfectRadius) return "perfect";
  if (d < PLAYER.goodRadius) return "good";
  return "late";
}

function chooseShot(input, useSpecial) {
  if (useSpecial) return SHOTS.special;
  if (input.shotUp || (!("shotUp" in input) && input.up)) return SHOTS.lob;
  if (input.shotDown || (!("shotDown" in input) && input.down)) return SHOTS.drop;
  if (input.hit && Math.abs(input.aim) > 0.72) return SHOTS.power;
  return SHOTS.normal;
}

function chooseTargetX(room, playerId, input) {
  const opponent = playerId === "p1" ? room.players.p2 : room.players.p1;
  if (Math.abs(input.aim) > 0.15) return input.aim * 3.55;
  return clamp(-opponent.x * 0.52 + rand(-0.9, 0.9), -3.5, 3.5);
}

function chooseTargetY(side, shot) {
  if (side > 0) {
    if (shot.kind === "drop") return rand(-5.1, -3.9);
    if (shot.kind === "lob") return rand(-11.2, -9.2);
    return rand(-10.8, -7.4);
  }
  if (shot.kind === "drop") return rand(3.9, 5.1);
  if (shot.kind === "lob") return rand(9.2, 11.2);
  return rand(7.4, 10.8);
}

function launchBallTo(room, targetX, targetY, shot, speedScale) {
  const t = Math.max(0.45, shot.time / speedScale);
  const ball = room.ball;
  ball.vx = (targetX - ball.x) / t;
  ball.vy = (targetY - ball.y) / t;
  ball.vz = (0 - ball.z + 0.5 * BALL.gravity * t * t) / t;
}

function opponentOf(playerId) {
  return playerId === "p1" ? "p2" : "p1";
}

function endPoint(room, winner, reason) {
  room.ball.inPlay = false;
  room.phase = "pointOver";
  room.timer = 1.1;
  room.pointWinner = winner;
  room.message = reason;
  room.messageSub = `${winner === "p1" ? "PLAYER 1" : "PLAYER 2"} POINT`;
  if (winner === "p1") room.playerPoints += 1;
  else room.aiPoints += 1;
  applyGameScore(room, winner);
}

function applyGameScore(room) {
  if (room.playerPoints < 4 && room.aiPoints < 4) return;
  const diff = room.playerPoints - room.aiPoints;
  if (Math.abs(diff) < 2) return;
  const winner = diff > 0 ? "p1" : "p2";
  room.playerPoints = 0;
  room.aiPoints = 0;
  if (winner === "p1") {
    room.playerGames += 1;
    room.message = "PLAYER 1 GAME";
  } else {
    room.aiGames += 1;
    room.message = "PLAYER 2 GAME";
  }
  room.messageSub = "CHANGE SERVER";
  room.server = opponentOf(room.server);
  room.timer = 1.65;
  if (room.playerGames >= room.gamesToWin || room.aiGames >= room.gamesToWin) {
    room.phase = "matchOver";
    room.timer = 0;
    room.message = "";
    room.messageSub = "";
    room.result = {
      winner,
      playerGames: room.playerGames,
      aiGames: room.aiGames,
      maxRally: room.maxRally,
    };
  }
}

function snapshotRoom(room) {
  return {
    type: "state",
    room: room.id,
    phase: room.phase,
    timer: room.timer,
    message: room.message,
    messageSub: room.messageSub,
    server: room.server,
    lastHit: room.lastHit,
    players: {
      p1: publicPlayer(room.players.p1),
      p2: publicPlayer(room.players.p2),
    },
    ball: room.ball,
    score: {
      playerPoints: room.playerPoints,
      aiPoints: room.aiPoints,
      playerGames: room.playerGames,
      aiGames: room.aiGames,
    },
    rallyHits: room.rallyHits,
    maxRally: room.maxRally,
    themeIndex: room.themeIndex,
    result: room.result,
    updatedAt: Date.now(),
  };
}

function publicPlayer(player) {
  return {
    id: player.id,
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    cooldown: player.cooldown,
    energy: player.energy,
    connected: player.connected,
  };
}

function broadcastRoom(room) {
  const state = snapshotRoom(room);
  for (const client of room.clients.values()) {
    sendJson(client, state);
  }
}

function handleMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    sendJson(client, { type: "error", message: "Invalid JSON" });
    return;
  }
  if (message.type === "join") {
    joinRoom(client, message.room);
    return;
  }
  const room = client.room;
  if (!room) {
    sendJson(client, { type: "error", message: "Join a room first" });
    return;
  }
  if ((client.playerId !== "p1" && client.playerId !== "p2") && message.type !== "join") return;

  if (message.type === "input") {
    const next = message.input || {};
    room.inputs[client.playerId] = {
      left: !!next.left,
      right: !!next.right,
      up: !!next.up,
      down: !!next.down,
      hit: !!next.hit,
      special: !!next.special,
      aim: clamp(Number(next.aim) || 0, -1, 1),
      shotUp: !!next.shotUp,
      shotDown: !!next.shotDown,
    };
  } else if (message.type === "action") {
    if (message.action === "replay" || message.action === "continue") {
      resetMatch(room);
      broadcastRoom(room);
    }
  } else if (message.type === "theme") {
    room.themeIndex = clamp(Number(message.index) || 0, 0, 2);
    broadcastRoom(room);
  }
}

function sendJson(client, data) {
  if (!client.socket.writable) return;
  client.socket.write(encodeFrame(JSON.stringify(data)));
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, payload]);
}

function decodeFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  const messages = [];
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < offset + 2) break;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) break;
      length = Number(client.buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (client.buffer.length < offset + length) break;

    if (opcode === 0x8) {
      client.socket.end();
      return messages;
    }
    if (opcode === 0x9) {
      client.socket.write(Buffer.from([0x8a, 0x00]));
      client.buffer = client.buffer.slice(offset + length);
      continue;
    }
    let payload = client.buffer.slice(offset, offset + length);
    if (masked) {
      const mask = client.buffer.slice(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
    client.buffer = client.buffer.slice(offset + length);
  }
  return messages;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".md": "text/markdown; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": mimeType(filePath),
      "cache-control": "no-store",
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(serveStatic);

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  const client = {
    id: crypto.randomBytes(8).toString("hex"),
    socket,
    room: null,
    playerId: null,
    buffer: Buffer.alloc(0),
  };
  connections.add(client);
  socket.on("data", (chunk) => {
    for (const message of decodeFrames(client, chunk)) {
      handleMessage(client, message);
    }
  });
  socket.on("close", () => {
    leaveRoom(client);
    connections.delete(client);
  });
  socket.on("error", () => {
    leaveRoom(client);
    connections.delete(client);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    updateRoom(room, TICK_MS / 1000, now);
  }
}, TICK_MS);

server.listen(PORT, HOST, () => {
  console.log(`Pixel Tennis multiplayer server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/?mode=online to create a room.`);
});
