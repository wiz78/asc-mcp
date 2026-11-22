// Required tests have no account or public-network dependency.
import http from "node:http";
import https from "node:https";
import net from "node:net";

globalThis.fetch = async () => { throw new Error("External fetch is blocked in the account-free test suite."); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node HTTP agents pass normalized [options, callback] arguments.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof options === "object" && options && typeof options.path === "string") ||
      (typeof options === "string" && options.startsWith("/"))) {
    return connect.apply(this, args);
  }
  throw new Error("TCP connections are blocked in the account-free test suite.");
};
for (const protocol of [http, https]) {
  const request = protocol.request;
  protocol.request = function (options, ...args) {
    if (options && typeof options === "object" && typeof options.socketPath === "string") return request.call(this, options, ...args);
    throw new Error("HTTP networking is blocked in the account-free test suite.");
  };
}
