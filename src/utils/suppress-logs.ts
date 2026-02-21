// Must be imported BEFORE @whiskeysockets/baileys to intercept console
// references captured at import time. libsignal uses console.info and
// console.warn to dump full session objects (~40 lines of noise).
const _origInfo = console.info;
console.info = function (...args: unknown[]) {
  if (typeof args[0] === "string" && args[0].startsWith("Closing session")) return;
  _origInfo.apply(console, args);
};
const _origWarn = console.warn;
console.warn = function (...args: unknown[]) {
  if (typeof args[0] === "string" && args[0].startsWith("Session already closed")) return;
  _origWarn.apply(console, args);
};
