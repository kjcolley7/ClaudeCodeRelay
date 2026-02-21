// Must be imported BEFORE @whiskeysockets/baileys to intercept console.log
// references captured at import time. Baileys' signal protocol code uses raw
// console.log to dump full session objects (~40 lines of noise).
const _origLog = console.log;
console.log = function (...args: unknown[]) {
  if (typeof args[0] === "string" && args[0].startsWith("Closing session")) return;
  _origLog.apply(console, args);
};
