import { DATA_COLUMNS, Telemetry } from "./types";

export type DataSource = "srad" | "cots" | "replay";

function numberOrNull(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSradTelemetry(line: string): Telemetry | null {
  const parts = line.trim().split(",");
  if (parts.length < 12) {
    return null;
  }

  const values = parts.slice(0, 12).map(numberOrNull);
  if (values.some((value) => value === null)) {
    return null;
  }

  return {
    time: values[0]!,
    Temp: values[1]!,
    pressure: values[2]!,
    altitude: values[3]!,
    accX: values[4]!,
    accY: values[5]!,
    accZ: values[6]!,
    gyroX: values[7]!,
    gyroY: values[8]!,
    gyroZ: values[9]!,
    lat: values[10]!,
    lon: values[11]!,
    // Optional receiver status fields 12-15: rssi,snr,sats,gpsFix
    ...(parts.length >= 16
      ? {
          rssi: numberOrNull(parts[12]),
          snr: numberOrNull(parts[13]),
          sats: numberOrNull(parts[14]),
          gpsFix: numberOrNull(parts[15]),
        }
      : {}),
  };
}

export function parseTelemetryCsv(csv: string): Telemetry[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }

  const header = lines[0].split(",").map((column) => column.trim());
  const columns = DATA_COLUMNS.map(({ key }) => key);
  const columnIndexes = columns.map((column) => header.indexOf(column));
  const hasHeader = columnIndexes.every((index) => index >= 0);
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map((line) => {
      const values = line.split(",");
      const packet = columns.map((column, index) => ({
        column,
        value: numberOrNull(values[hasHeader ? columnIndexes[index] : index] ?? ""),
      }));

      if (packet.some(({ value }) => value === null)) {
        return null;
      }

      return Object.fromEntries(
        packet.map(({ column, value }) => [column, value]),
      ) as Telemetry;
    })
    .filter((packet): packet is Telemetry => packet !== null);
}

type TextPosition = { lat: number; lon: number };

export type FeatherweightParseResult = {
  telemetry: Telemetry[];
  text: string[];
  binaryHex: string[];
  warnings: string[];
};

function parseGpsTextPosition(line: string): TextPosition | null {
  const parts = line.trim().replace(/^@\s*/, "").split(/\s+/);
  if (parts[0] !== "GPS_STAT") {
    return null;
  }

  const latitudeIndex = parts.indexOf("lt");
  const longitudeIndex = parts.indexOf("ln");
  if (latitudeIndex < 0 || longitudeIndex < 0) {
    return null;
  }

  const lat = numberOrNull(parts[latitudeIndex + 1]);
  const lon = numberOrNull(parts[longitudeIndex + 1]);
  return lat !== null && lon !== null ? { lat, lon } : null;
}

export function parseCotsGpsTelemetry(
  line: string,
  time: number,
): Telemetry | null {
  const parts = line.trim().replace(/^@\s*/, "").split(/\s+/);
  if (parts[0] !== "GPS_STAT") {
    return null;
  }

  const altitudeIndex = parts.indexOf("Alt");
  const latitudeIndex = parts.indexOf("lt");
  const longitudeIndex = parts.indexOf("ln");
  if (altitudeIndex < 0 || latitudeIndex < 0 || longitudeIndex < 0) {
    return null;
  }

  const altitude = numberOrNull(parts[altitudeIndex + 1]);
  const position = parseGpsTextPosition(line);
  if (altitude === null || position === null) {
    return null;
  }

  return {
    time,
    Temp: null,
    pressure: null,
    altitude,
    accX: null,
    accY: null,
    accZ: null,
    gyroX: null,
    gyroY: null,
    gyroZ: null,
    lat: position.lat,
    lon: position.lon,
  };
}

function parseFwtPositionFrame(frame: Uint8Array, time: number): Telemetry | null {
  const trackerId = frame.slice(9, 20);
  const hasValidTrackerId =
    trackerId.length === 11 &&
    trackerId.every(
      (byte) =>
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        byte === 0x5f ||
        byte === 0x2d,
    );

  if (
    frame.length < 32 ||
    frame[0] !== 0x46 ||
    frame[1] !== 0x57 ||
    frame[2] !== 0x54 ||
    !hasValidTrackerId ||
    (frame[6] === 0xa1 && frame[7] === 0x09 && frame[8] === 0x00)
  ) {
    return null;
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const lat = view.getInt32(20, true) / 1e7;
  const lon = view.getInt32(24, true) / 1e7;
  const altitude = view.getInt32(28, true) / 304.8;

  if (
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    lon === 0
  ) {
    return null;
  }

  return {
    time,
    Temp: null,
    pressure: null,
    altitude,
    accX: null,
    accY: null,
    accZ: null,
    gyroX: null,
    gyroY: null,
    gyroZ: null,
    lat,
    lon,
  };
}

function findFrameEnd(bytes: number[], start: number): number {
  for (let index = start + 32; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      return index;
    }
  }
  return -1;
}

function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

export class FeatherweightTelemetryParser {
  private buffer: number[] = [];
  private lastTextPosition: TextPosition | null = null;
  private lastBinaryPosition: TextPosition | null = null;

  reset(): void {
    this.buffer = [];
    this.lastTextPosition = null;
    this.lastBinaryPosition = null;
  }

  push(input: Uint8Array, time: number): FeatherweightParseResult {
    this.buffer.push(...input);
    const result: FeatherweightParseResult = {
      telemetry: [],
      text: [],
      binaryHex: [],
      warnings: [],
    };

    while (this.buffer.length > 0) {
      const fwtIndex = this.buffer.findIndex(
        (byte, index) =>
          byte === 0x46 &&
          this.buffer[index + 1] === 0x57 &&
          this.buffer[index + 2] === 0x54,
      );
      const textIndex = this.buffer.indexOf(0x40);

      if (fwtIndex < 0 && textIndex < 0) {
        this.buffer = this.buffer.slice(-2);
        break;
      }

      if (fwtIndex >= 0 && (textIndex < 0 || fwtIndex < textIndex)) {
        if (fwtIndex > 0) {
          this.buffer = this.buffer.slice(fwtIndex);
        }
        if (this.buffer.length < 32) break;

        const frameEnd = findFrameEnd(this.buffer, 0);
        if (frameEnd < 0) break;

        const frame = new Uint8Array(this.buffer.slice(0, frameEnd));
        this.buffer = this.buffer.slice(frameEnd + 2);
        result.binaryHex.push(formatHex(frame));

        const packet = parseFwtPositionFrame(frame, time);
        if (packet) {
          result.telemetry.push(packet);
          this.lastBinaryPosition = { lat: packet.lat!, lon: packet.lon! };
          if (
            this.lastTextPosition &&
            (Math.abs(this.lastTextPosition.lat - packet.lat!) > 0.01 ||
              Math.abs(this.lastTextPosition.lon - packet.lon!) > 0.01)
          ) {
            result.warnings.push(
              `GPS text differs from binary position: text (${this.lastTextPosition.lat}, ${this.lastTextPosition.lon}), binary (${packet.lat}, ${packet.lon})`,
            );
          }
        }
        continue;
      }

      if (textIndex > 0) {
        this.buffer = this.buffer.slice(textIndex);
      }
      const lineEnd = this.buffer.findIndex(
        (byte, index) => byte === 0x0d && this.buffer[index + 1] === 0x0a,
      );
      if (lineEnd < 0) break;

      const line = new TextDecoder().decode(new Uint8Array(this.buffer.slice(0, lineEnd)));
      this.buffer = this.buffer.slice(lineEnd + 2);
      result.text.push(line);

      const textPosition = parseGpsTextPosition(line);
      if (textPosition) {
        this.lastTextPosition = textPosition;
        if (
          this.lastBinaryPosition &&
          (Math.abs(this.lastBinaryPosition.lat - textPosition.lat) > 0.01 ||
            Math.abs(this.lastBinaryPosition.lon - textPosition.lon) > 0.01)
        ) {
          result.warnings.push(
            `GPS text differs from binary position: text (${textPosition.lat}, ${textPosition.lon}), binary (${this.lastBinaryPosition.lat}, ${this.lastBinaryPosition.lon})`,
          );
        }
      }
    }

    return result;
  }
}
