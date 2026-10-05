// Who sent a request, for counting wrong setup keys per visitor.
//
// A proxy inside the container (the one-port router, docker/router) connects
// from loopback, so every request through it would look like one visitor: one
// person's wrong guesses would slow everyone down, and anyone's right key
// would clear a guesser's count. The router appends the address it saw to
// X-Forwarded-For, so from loopback, and only from loopback, that last entry
// is the visitor. Nothing outside the container can connect from loopback, and
// a process inside it can read the key anyway, so trusting it gives nothing
// away. Earlier entries were written by whoever connected, and are ignored.
import { isIP } from "node:net";

/** A peer address as a person would write it: no IPv4-mapped IPv6 prefix. */
export const plainAddress = (address) => String(address ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");

export const isLoopback = (address) => {
  const plain = plainAddress(address);
  return plain === "::1" || /^127\.\d+\.\d+\.\d+$/.test(plain);
};

/** The visitor's address: the socket's peer, or the router's word for it. */
export function clientAddress(req) {
  const peer = plainAddress(req?.socket?.remoteAddress) || "?";
  if (!isLoopback(peer)) return peer;
  const header = req?.headers?.["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : String(header ?? "")).split(",");
  const last = plainAddress(forwarded[forwarded.length - 1].trim());
  return isIP(last) ? last : peer;
}
