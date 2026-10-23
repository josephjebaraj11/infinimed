/**
 * HL7 v2.x ER7 parser. Handles the encoding characters declared in MSH-1/MSH-2 (field, component,
 * repetition, escape, subcomponent), escape sequences (\F\ \S\ \T\ \R\ \E\ \X..\ \.br\), segment
 * terminators \r, \n or \r\n, and MLLP framing bytes if a caller forwards them unstripped.
 *
 * Field numbering follows the standard: for MSH, MSH-1 is the field separator itself, so
 * `field(msh, 9)` is the message type exactly as written in specifications.
 */

export type Encoding = { field: string; component: string; repetition: string; escape: string; subcomponent: string };

export type Segment = { name: string; fields: string[] };

export type Message = { encoding: Encoding; segments: Segment[] };

export class Hl7ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Hl7ParseError";
  }
}

export function parseMessage(raw: string): Message {
  const text = raw.replace(/^\u000b/, "").replace(/\u001c\r?$/, "").replace(/\u001c/g, "");
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  const first = lines[0];
  if (!first || !first.startsWith("MSH")) throw new Hl7ParseError("Message must start with an MSH segment");
  const fieldSep = first[3];
  const encChars = first.slice(4, 8);
  if (!fieldSep || encChars.length < 4) throw new Hl7ParseError("MSH encoding characters are missing");
  const encoding: Encoding = {
    field: fieldSep,
    component: encChars[0]!,
    repetition: encChars[1]!,
    escape: encChars[2]!,
    subcomponent: encChars[3]!,
  };
  const segments = lines.map((line) => {
    const parts = line.split(encoding.field);
    const name = parts[0]!;
    if (name === "MSH") {
      // MSH-1 is the separator, MSH-2 the encoding characters; shift so indexes match the spec.
      return { name, fields: [name, encoding.field, ...parts.slice(1)] };
    }
    return { name, fields: parts };
  });
  return { encoding, segments };
}

export function unescape(value: string, enc: Encoding): string {
  if (!value.includes(enc.escape)) return value;
  const e = enc.escape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`${e}(.*?)${e}`, "g"), (_, seq: string) => {
    switch (seq) {
      case "F":
        return enc.field;
      case "S":
        return enc.component;
      case "T":
        return enc.subcomponent;
      case "R":
        return enc.repetition;
      case "E":
        return enc.escape;
      case ".br":
        return "\n";
      default:
        if (/^X[0-9A-Fa-f]+$/.test(seq)) {
          return Buffer.from(seq.slice(1), "hex").toString("latin1");
        }
        return "";
    }
  });
}

export function segments(msg: Message, name: string): Segment[] {
  return msg.segments.filter((s) => s.name === name);
}

export function segment(msg: Message, name: string): Segment | undefined {
  return msg.segments.find((s) => s.name === name);
}

/** Raw field value (all repetitions). */
export function fieldRaw(seg: Segment | undefined, index: number): string {
  return seg?.fields[index] ?? "";
}

export function repetitions(msg: Message, seg: Segment | undefined, index: number): string[] {
  const raw = fieldRaw(seg, index);
  if (!raw) return [];
  if (seg?.name === "MSH" && index <= 2) return [raw];
  return raw.split(msg.encoding.repetition);
}

/** Component (1-based) of the first repetition, unescaped. */
export function comp(msg: Message, seg: Segment | undefined, index: number, component = 1, sub = 1): string {
  const rep = repetitions(msg, seg, index)[0] ?? "";
  return componentOf(msg, rep, component, sub);
}

export function componentOf(msg: Message, repetition: string, component = 1, sub = 1): string {
  const c = repetition.split(msg.encoding.component)[component - 1] ?? "";
  const s = c.split(msg.encoding.subcomponent)[sub - 1] ?? "";
  return unescape(s, msg.encoding);
}

/** HL7 DTM (YYYY[MM[DD[HH[MM[SS[.S+]]]]]][+/-ZZZZ]) -> FHIR date or dateTime. */
export function hl7DateTime(value: string): string | undefined {
  const m = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.(\d+))?([+-]\d{4})?$/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, , tz] = m;
  if (!mo) return y;
  if (!d) return `${y}-${mo}`;
  if (!h) return `${y}-${mo}-${d}`;
  const zone = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : "Z";
  return `${y}-${mo}-${d}T${h}:${mi ?? "00"}:${s ?? "00"}${zone}`;
}
