// Gun.js relay peer for MYTHOS multiplayer.
// Runs behind nginx at https://vibing.at/gun (websocket proxied to this port).
const http = require("http");
const Gun = require("gun");

const PORT = Number(process.env.GUN_PORT || 8767);

const server = http.createServer((req, res) => {
  // Gun attaches its own websocket/request handlers; this is just the
  // fallback for plain HTTP probes.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("mythos gun relay up\n");
});

Gun({ web: server, file: "data" });

server.listen(PORT, "127.0.0.1", () => {
  console.log(`gun relay listening on 127.0.0.1:${PORT}`);
});
