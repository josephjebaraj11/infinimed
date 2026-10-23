import { comp, segment, type Message } from "./parser.js";

/** Builds an original-mode ACK (AA accept, AE error, AR reject) mirroring the inbound MSH. */
export function buildAck(msg: Message | null, code: "AA" | "AE" | "AR", text = ""): string {
  const now = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const msh = msg ? segment(msg, "MSH") : undefined;
  const fs = msg?.encoding.field ?? "|";
  const enc = msg ? `${msg.encoding.component}${msg.encoding.repetition}${msg.encoding.escape}${msg.encoding.subcomponent}` : "^~\\&";
  const sendingApp = msh && msg ? comp(msg, msh, 3) : "";
  const sendingFac = msh && msg ? comp(msg, msh, 4) : "";
  const controlId = msh && msg ? comp(msg, msh, 10) : "";
  const version = msh && msg ? comp(msg, msh, 12) || "2.5.1" : "2.5.1";
  const trigger = msh && msg ? comp(msg, msh, 9, 2) : "";
  const safeText = text.replace(/[|^~\\&\r\n]/g, " ").slice(0, 80);
  return [
    ["MSH", enc, "INFINIMED", "INFINIMED", sendingApp, sendingFac, now, "", `ACK^${trigger}^ACK`, `ACK${now}`, "P", version].join(fs),
    ["MSA", code, controlId, safeText].join(fs),
  ].join("\r");
}
