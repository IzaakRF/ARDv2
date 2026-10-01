

export const MAX_DATA_POINTS = 100; // Number of points to hold temporarily in memory (queue)

// export type STATUS = "connected" | "disconnected" | "awaiting";
export enum STATUS {
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  AWAITING = "awaiting"
}

export enum PAGE {
  TELEMETRY = "telemetry",
  SETTINGS = "settings",
  GRAPHS = "graphs",
  MAP = "map"
}

export type Metric = {
  title: string;
  value: number | string;
  unit: string;
};

export type Telemetry = {
  time: number | null;
  Temp: number | null;
  pressure: number | null;
  altitude: number | null;
  accX: number | null;
  accY: number | null;
  accZ: number | null;
  gyroX: number | null;
  gyroY: number | null;
  gyroZ: number | null;
  lat: number | null;
  lon: number | null;
  // Optional radio/GPS status appended after the 12 SRAD fields by the ESP32
  // ground station receiver (rssi,snr,sats,gpsFix). Absent for other sources.
  rssi?: number | null; // LoRa packet RSSI, dBm
  snr?: number | null; // LoRa packet SNR, dB
  sats?: number | null; // GPS satellites used
  gpsFix?: number | null; // 1 = rocket GPS has a fix, 0 = no fix
};

export const DEFAULT_TELEMETRY_DATA: Telemetry = {
  time: null,
  Temp: null,
  pressure: null,
  altitude: null,
  accX: null,
  accY: null,
  accZ: null,
  gyroX: null,
  gyroY: null,
  gyroZ: null,
  lat: null,
  lon: null,
};

// True when the sample's position is a real GPS fix (gpsFix when the receiver
// reports it, otherwise a non-zero lat/lon)
export function hasGpsFix(data: Telemetry): boolean {
  if (data.gpsFix !== undefined && data.gpsFix !== null) {
    return data.gpsFix > 0;
  }
  return (
    data.lat !== null &&
    data.lon !== null &&
    Number.isFinite(data.lat) &&
    Number.isFinite(data.lon) &&
    (data.lat !== 0 || data.lon !== 0)
  );
}

export function formatTelemetryValue(
  value: number | null,
  digits = 2,
): string {
  return value === null ? "--.--" : value.toFixed(digits);
}

export const DATA_COLUMNS: { key: keyof Telemetry; label: string }[] = [
  { key: "time", label: "Time" },
  { key: "Temp", label: "Temp" },
  { key: "pressure", label: "Pressure" },
  { key: "altitude", label: "Altitude" },
  { key: "accX", label: "Acc X" },
  { key: "accY", label: "Acc Y" },
  { key: "accZ", label: "Acc Z" },
  { key: "gyroX", label: "Gyro X" },
  { key: "gyroY", label: "Gyro Y" },
  { key: "gyroZ", label: "Gyro Z" },
  { key: "lat", label: "Latitude" },
  { key: "lon", label: "Longitude" },
];

export const PLOT_METADATA: { key: keyof Telemetry; label: string, color: string }[] = [
  { key: "Temp", label: "Temp", color: "#ff6730" },    
  { key: "pressure", label: "Pressure", color: "#ffba30" },    
  { key: "gyroX", label: "Gyro X", color: "#ff668f" },
  { key: "gyroY", label: "Gyro Y", color: "#65f7bf" },
  { key: "gyroZ", label: "Gyro Z", color: "#5ad8ff" }
];
