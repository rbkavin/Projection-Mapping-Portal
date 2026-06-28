/**
 * Minimal WebSocket relay: Specs sends pose JSON, browsers receive it.
 * Usage: npm start  (default ws://0.0.0.0:8765)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

const PORT = Number(process.env.PORT || 8765);
const PUBLIC_DIR = path.join(__dirname, "public");
const PING_MS = 25000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".gltf": "model/gltf+json",
  ".glb":  "model/gltf-binary",
  ".bin":  "application/octet-stream",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
};

function serveStatic(req, res) {
  if (req.url === "/api/info") {
    const lanIp = getLanIp();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ port: PORT, lanIp, wsUrl: `ws://${lanIp}:${PORT}` }));
    return;
  }
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, clientTracking: true });

let specsClient = null;
const viewers = new Set();
let lastPose = null;
let lastCalibration = null;
let lastSpecsMode = "unknown";
let poseCount = 0;
let calibrationCount = 0;
let lastPoseLog = 0;

function isSpecsConnected() {
  return specsClient !== null && specsClient.readyState === 1;
}

function specsStatusMessage() {
  return JSON.stringify({
    type: "specs_status",
    connected: isSpecsConnected(),
    poseCount: poseCount,
    viewerCount: viewers.size,
  });
}

function broadcastToViewers(data, isBinary) {
  for (const client of viewers) {
    if (client.readyState === 1) {
      client.send(data, { binary: isBinary });
    }
  }
}

function notifySpecsStatus() {
  broadcastToViewers(specsStatusMessage(), false);
}

function roleLabel(ws) {
  if (ws === specsClient) return "specs";
  if (viewers.has(ws)) return "viewer";
  return "unknown";
}

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log("[ws] connect", ip);

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "pong") {
      return;
    }

    if (msg.type === "hello" && msg.role === "specs") {
      if (specsClient && specsClient !== ws && specsClient.readyState === 1) {
        console.log("[ws] replacing previous Specs connection");
        specsClient.close();
      }
      specsClient = ws;
      lastSpecsMode = msg.mode || "unknown";
      console.log("[ws] SPECS CONNECTED", msg.sessionId || "", "mode=" + lastSpecsMode, "from", ip);
      ws.send(JSON.stringify({ type: "ack", role: "specs" }));
      notifySpecsStatus();
      if (lastPose) {
        ws.send(JSON.stringify(lastPose));
      }
      return;
    }

    if (msg.type === "hello" && msg.role === "viewer") {
      viewers.add(ws);
      console.log("[ws] viewer registered", viewers.size, "total from", ip);
      ws.send(JSON.stringify({ type: "ack", role: "viewer" }));
      ws.send(specsStatusMessage());
      ws.send(
        JSON.stringify({
          type: "sync",
          calibration: lastCalibration,
          pose: lastPose,
        })
      );
      return;
    }

    if (msg.type === "calibration") {
      if (!msg.resend || !lastCalibration) {
        calibrationCount += 1;
      }
      lastCalibration = msg;
      const ids = (msg.corners || []).map((c) => c.id).join(",");
      const tag = msg.resend ? " (resend)" : "";
      console.log(
        "[calibration] #" + calibrationCount + tag + " locked corners [" + ids + "] from",
        ip
      );
      broadcastToViewers(JSON.stringify(msg), false);
      return;
    }

    if (msg.type === "pose") {
      lastPose = msg;
      poseCount += 1;
      const now = Date.now();
      if (now - lastPoseLog > 2000 || poseCount <= 3) {
        lastPoseLog = now;
        const p = msg.position || {};
        const space = msg.space || "world";
        const viewerNote =
          viewers.size === 0 ? " (NO BROWSER — keep http://localhost:" + PORT + " open)" : "";
        console.log(
          "[pose] #" + poseCount +
            " " + space +
            " pos " + (p.x ?? 0).toFixed(2) + ", " + (p.y ?? 0).toFixed(2) + ", " + (p.z ?? 0).toFixed(2) +
            " -> " + viewers.size + " viewer(s)" + viewerNote
        );
      }
      broadcastToViewers(JSON.stringify(msg), false);
      return;
    }

    if (msg.type === "debug") {
      if (msg.error) {
        console.log("[specs-debug] error: " + msg.error);
      }
      return;
    }
  });

  ws.on("close", (code) => {
    const role = roleLabel(ws);
    if (ws === specsClient) {
      console.log("[ws] SPECS DISCONNECTED code=" + code);
      specsClient = null;
      notifySpecsStatus();
    }
    if (viewers.has(ws)) {
      viewers.delete(ws);
      console.log("[ws] viewer disconnected code=" + code + " — viewers:", viewers.size);
    } else if (role === "unknown") {
      console.log("[ws] closed before hello code=" + code, "from", ip);
    }
  });
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log("[ws] terminating unresponsive client (" + roleLabel(ws) + ")");
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
    if (ws.readyState === 1 && viewers.has(ws)) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }
}, PING_MS);

wss.on("close", () => {
  clearInterval(pingInterval);
});

server.listen(PORT, "0.0.0.0", () => {
  const lanIp = getLanIp();
  console.log("");
  console.log("┌─────────────────────────────────────────────────┐");
  console.log("  Portal Studio relay");
  console.log("  Open in browser:   http://" + lanIp + ":" + PORT);
  console.log("  Spectacles URL:    ws://"  + lanIp + ":" + PORT);
  console.log("└─────────────────────────────────────────────────┘");
  console.log("");
});
