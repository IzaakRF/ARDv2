import type { DataSource } from "./serialParsers";

export const DEFAULT_CONFIG = {
  launchSite: {
    latitude: -30.664806,
    longitude: 143.196306,
  },
  targetAltitude: 10000,
  connection: {
    transport: "serial" as const,
    websocketUrl: "ws://localhost:8765",
    baudRate: 115200,
  },
  dataSource: "cots" as DataSource,
};
