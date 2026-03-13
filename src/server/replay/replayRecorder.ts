import { writeFile } from "node:fs/promises";
import { BinaryWriter, encodePacket } from "../../common/binary.js";
import type { JudgeEvent, TouchFrame, UserInfo } from "../../common/commands.js";
import { encodeClientCommand } from "../../common/commands.js";
import { roomIdToString, type RoomId } from "../../common/roomId.js";
import { ensureReplayDir, replayFilePath } from "../replay/replayStorage.js";

export type ReplayChartInfo = {
  id: number;
  name: string;
};

export type ReplayUserInfo = {
  id: number;
  name: string;
};

type InFlight = {
  roomKey: string;
  userId: number;
  chartId: number;
  recordId: number;
  timestamp: number;
  path: string;
  packets: Buffer[];
};

export class ReplayRecorder {
  private readonly baseDir: string;
  private readonly inflightByKey = new Map<string, InFlight>();
  private readonly keysByRoom = new Map<string, Set<string>>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async startRoom(roomId: RoomId, chart: ReplayChartInfo, users: ReplayUserInfo[]): Promise<void> {
    const roomKey = roomIdToString(roomId);
    const existing = this.keysByRoom.get(roomKey);
    if (existing && existing.size > 0) return;

    const keys = new Set<string>();
    for (const user of users) {
      const userId = user.id;
      if (!Number.isInteger(userId) || userId < 0) continue;
      const ts = Date.now();
      await ensureReplayDir(this.baseDir, userId, chart.id);
      const path = replayFilePath(this.baseDir, userId, chart.id, ts);
      const key = `${roomKey}:${userId}`;
      this.inflightByKey.set(key, {
        roomKey,
        userId,
        chartId: chart.id,
        recordId: 0,
        timestamp: ts,
        path,
        packets: []
      });
      keys.add(key);
    }
    if (keys.size > 0) this.keysByRoom.set(roomKey, keys);
  }

  async endRoom(roomId: RoomId): Promise<void> {
    const roomKey = roomIdToString(roomId);
    const keys = this.keysByRoom.get(roomKey);
    if (!keys) return;
    this.keysByRoom.delete(roomKey);

    const tasks: Promise<void>[] = [];
    for (const key of keys) {
      const it = this.inflightByKey.get(key);
      if (!it) continue;
      this.inflightByKey.delete(key);
      tasks.push(this.persistInFlight(it));
    }
    await Promise.allSettled(tasks);
  }

  setRecordId(roomId: RoomId, userId: number, recordId: number): void {
    const roomKey = roomIdToString(roomId);
    const key = `${roomKey}:${userId}`;
    const it = this.inflightByKey.get(key);
    if (!it) return;
    if (!Number.isInteger(recordId) || recordId < 0) return;
    it.recordId = recordId >>> 0;
  }

  appendTouches(roomId: RoomId, userId: number, frames: TouchFrame[]): void {
    const it = this.get(roomId, userId);
    if (!it) return;
    if (frames.length === 0) return;
    const payload = encodePacket({ type: "Touches", frames }, encodeClientCommand);
    it.packets.push(payload);
  }

  appendJudges(roomId: RoomId, userId: number, judges: JudgeEvent[]): void {
    const it = this.get(roomId, userId);
    if (!it) return;
    if (judges.length === 0) return;
    const payload = encodePacket({ type: "Judges", judges }, encodeClientCommand);
    it.packets.push(payload);
  }

  listRoomFiles(roomId: RoomId): Array<{ userId: number; chartId: number; timestamp: number; path: string }> {
    const roomKey = roomIdToString(roomId);
    const keys = this.keysByRoom.get(roomKey);
    if (!keys) return [];
    const out: Array<{ userId: number; chartId: number; timestamp: number; path: string }> = [];
    for (const key of keys) {
      const it = this.inflightByKey.get(key);
      if (!it) continue;
      out.push({ userId: it.userId, chartId: it.chartId, timestamp: it.timestamp, path: it.path });
    }
    return out;
  }

  fakeMonitorInfo(): UserInfo {
    return { id: 2_000_000_000, name: "回放录制器", monitor: true };
  }

  private get(roomId: RoomId, userId: number): InFlight | null {
    const roomKey = roomIdToString(roomId);
    const key = `${roomKey}:${userId}`;
    const it = this.inflightByKey.get(key);
    if (!it) return null;
    return it;
  }

  private async persistInFlight(it: InFlight): Promise<void> {
    const buffer = this.buildPhiraRec(it);
    await writeFile(it.path, buffer);
  }

  private buildPhiraRec(it: InFlight): Buffer {
    const writer = new BinaryWriter();
    writer.writeU16(0x504d);
    writer.writeU32(it.chartId >>> 0);
    writer.writeU32(it.userId >>> 0);
    writer.writeU32(it.recordId >>> 0);
    for (const payload of it.packets) {
      writer.writeU32(payload.length);
      writer.writeBuffer(payload);
    }
    return writer.toBuffer();
  }
}
