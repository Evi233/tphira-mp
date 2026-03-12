// 共享的测试工具函数
import { BinaryReader, decodePacket } from "../src/common/binary.js";
import { decodeClientCommand, type ClientCommand, type JudgeEvent, type TouchFrame } from "../src/common/commands.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(30);
  }
  throw new Error("等待超时");
}

export type ParsedPhiraRecHeader = {
  format: "pm" | "jphirarec";
  chartId: number;
  userId: number;
  recordId: number;
};

function parsePmHeader(buf: Buffer): ParsedPhiraRecHeader | null {
  if (buf.length < 14) return null;
  const magic = buf.readUInt16LE(0);
  if (magic !== 0x504d && magic !== 0x4d50) return null;
  return {
    format: "pm",
    chartId: buf.readUInt32LE(2),
    userId: buf.readUInt32LE(6),
    recordId: buf.readUInt32LE(10)
  };
}

function parseJPhiraRecHeader(buf: Buffer): ParsedPhiraRecHeader | null {
  if (buf.length < 20) return null;
  if (buf.subarray(0, 8).toString("ascii") !== "PHIRAREC") return null;
  const r = new BinaryReader(buf);
  r.take(8);
  r.readU32(); // version
  const recordId = r.readU32();
  const chartId = r.readU32();
  r.readString(); // chartName
  const userId = r.readI32();
  return { format: "jphirarec", chartId, userId, recordId };
}

function decodeTouchFrame(r: BinaryReader): TouchFrame {
  const time = r.readF32();
  const points = r.readArray((rr) => {
    const id = rr.readI8();
    const pos = rr.readCompactPos();
    return [id, pos] as [number, { x: number; y: number }];
  });
  return { time, points };
}

function decodeJudgeEvent(r: BinaryReader): JudgeEvent {
  const time = r.readF32();
  const line_id = r.readU32();
  const note_id = r.readU32();
  const judgement = r.readU8() as JudgeEvent["judgement"];
  return { time, line_id, note_id, judgement };
}

export function parsePhiraRecHeader(buf: Buffer): ParsedPhiraRecHeader {
  const pm = parsePmHeader(buf);
  if (pm) return pm;
  const j = parseJPhiraRecHeader(buf);
  if (j) return j;
  throw new Error("unknown-phirarec-header");
}

export function parsePhiraRec(buf: Buffer): ClientCommand[] {
  const header = parsePhiraRecHeader(buf);
  if (header.format === "jphirarec") {
    const r = new BinaryReader(buf);
    r.take(8);
    r.readU32(); // version
    r.readU32(); // recordId
    r.readU32(); // chartId
    r.readString(); // chartName
    r.readI32(); // userId
    r.readString(); // userName
    const frames = r.readArray(decodeTouchFrame);
    const judges = r.readArray(decodeJudgeEvent);
    return [
      { type: "Touches", frames },
      { type: "Judges", judges }
    ];
  }

  const out: ClientCommand[] = [];
  let offset = 14;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (offset + len > buf.length) break;
    const payload = buf.subarray(offset, offset + len);
    offset += len;
    out.push(decodePacket(payload, decodeClientCommand));
  }
  return out;
}

// Mock fetch 设置和自动清理
export function setupMockFetch() {
  const originalFetch = globalThis.fetch;
  let hitokotoCalls = 0;

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    
    if (url.startsWith("https://v1.hitokoto.cn/")) {
      hitokotoCalls += 1;
      return new Response(
        JSON.stringify({
          hitokoto: "欲买桂花同载酒，荒泷天下第一斗。",
          from: "原神",
          from_who: "钟离&荒泷一斗"
        }),
        { status: 200 }
      );
    }
    
    if (url.endsWith("/me")) {
      const auth = String(init?.headers && (init.headers as any).Authorization ? (init.headers as any).Authorization : (init?.headers as any)?.get?.("Authorization") ?? "");
      const token = auth.replace(/^Bearer\s+/i, "");
      if (token === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
        return new Response(JSON.stringify({ id: 100, name: "Alice", language: "zh-CN" }), { status: 200 });
      }
      if (token === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
        return new Response(JSON.stringify({ id: 200, name: "Bob", language: "zh-CN" }), { status: 200 });
      }
      if (token === "cccccccccccccccccccccccccccccccc") {
        return new Response(JSON.stringify({ id: 300, name: "Carol", language: "zh-CN" }), { status: 200 });
      }
      return new Response("unauthorized", { status: 401 });
    }

    if (/\/chart\/\d+$/.test(url)) {
      const id = Number(url.split("/").at(-1));
      return new Response(JSON.stringify({ id, name: `Chart-${id}` }), { status: 200 });
    }

    if (/\/record\/\d+$/.test(url)) {
      const id = Number(url.split("/").at(-1));
      return new Response(
        JSON.stringify({
          id,
          player: 100,
          score: 999999,
          perfect: 1,
          good: 0,
          bad: 0,
          miss: 0,
          max_combo: 1,
          accuracy: 1.0,
          full_combo: true,
          std: 0,
          std_score: 0
        }),
        { status: 200 }
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    originalFetch,
    mockFetch,
    getHitokotoCalls: () => hitokotoCalls,
    resetHitokotoCalls: () => { hitokotoCalls = 0; }
  };
}

/**
 * 自动设置和清理 Mock Fetch 的辅助函数
 * 在 beforeAll 中安装，在 afterAll 中恢复
 */
export function useMockFetch() {
  const { originalFetch, mockFetch, getHitokotoCalls, resetHitokotoCalls } = setupMockFetch();
  
  return {
    install: () => { globalThis.fetch = mockFetch; },
    restore: () => { globalThis.fetch = originalFetch; },
    getHitokotoCalls,
    resetHitokotoCalls
  };
}
