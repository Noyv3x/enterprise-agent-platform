"use strict";

// Camofox 1.11.2 calls app.listen(PORT), which makes Node listen on every
// interface. The managed platform loads this tiny preload before the upstream
// entry point and supplies a loopback host whenever a TCP listener omits one.
// Unix-domain sockets and explicitly-hosted listeners are left untouched.
const net = require("node:net");
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function managedLoopbackListen(...args) {
  if (typeof args[0] === "number") {
    if (typeof args[1] === "function" || args.length === 1) {
      args.splice(1, 0, "127.0.0.1");
    }
  } else if (
    args[0] &&
    typeof args[0] === "object" &&
    !args[0].path &&
    !args[0].host
  ) {
    args[0] = { ...args[0], host: "127.0.0.1" };
  }
  return originalListen.apply(this, args);
};
