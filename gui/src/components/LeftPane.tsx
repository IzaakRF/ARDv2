import { formatTelemetryValue, hasGpsFix, STATUS, Metric as TMetric, Telemetry } from "../types";
import { Metric } from "./Metric";

const iconColors: Record<STATUS, string> = {
  connected: "text-green",
  awaiting: "text-yellow",
  disconnected: "text-gray-600",
};


const labelColors: Record<STATUS, string> = {
  connected: "text-white",
  awaiting: "text-white",
  disconnected: "text-gray-600/50",
};


const getIconColor = (status: STATUS): string => iconColors[status];
const getLabelColor = (status: STATUS): string => labelColors[status]; 

type StatusRow = {
  title: string;
  status: STATUS;
  label?: string; // overrides the status text
  alert?: boolean; // show in red (e.g. LoRa link lost)
};

// Signal strength bars (0-5) from LoRa packet RSSI
const rssiBars = (rssi: number): number =>
  rssi >= -60 ? 5 : rssi >= -75 ? 4 : rssi >= -90 ? 3 : rssi >= -105 ? 2 : rssi >= -115 ? 1 : 0;

const SignalIndicator = ({ rssi, snr, live }: { rssi: number | null; snr: number | null; live: boolean }) => {
  const bars = rssi !== null && live ? rssiBars(rssi) : 0;
  return (
    <div className="flex flex-col">
      <span className="text-gray-600">Signal</span>
      <div className="flex items-end gap-3">
        <div className="flex items-end gap-0.5 h-5">
          {[1, 2, 3, 4, 5].map((level) => (
            <div
              key={level}
              className={`w-1.5 rounded-sm ${level <= bars ? (bars >= 3 ? "bg-green" : bars === 2 ? "bg-yellow" : "bg-red") : "bg-gray-600/30"}`}
              style={{ height: `${level * 20}%` }}
            />
          ))}
        </div>
        <span className="text-lg">
          {rssi !== null && live ? `${rssi.toFixed(0)} dBm` : "--.-- dBm"}
        </span>
        {snr !== null && live && (
          <span className="text-xs text-gray-600">SNR {snr.toFixed(1)} dB</span>
        )}
      </div>
    </div>
  );
};


interface Props {
  data: Telemetry;
  serial_status: STATUS;
  transport: "serial" | "websocket";
  healthStatus: "unknown" | "checking" | "healthy" | "starting" | "unavailable";
  loraLink: "connected" | "lost" | "offline";
}

const LeftPane = ({ data, serial_status, transport, healthStatus, loraLink } : Props) => {

  const receiverStatus: STATUS = healthStatus === "healthy"
    ? STATUS.CONNECTED
    : healthStatus === "starting"
      || healthStatus === "checking"
      || (transport === "websocket" && serial_status === STATUS.CONNECTED)
      ? STATUS.AWAITING
      : STATUS.DISCONNECTED;
  const connectionData: StatusRow[] = transport === "serial"
    ? [{ title: "Serial Port", status: serial_status }]
    : healthStatus === "unknown"
      ? []
      : [
          { title: "WebSocket Server", status: serial_status },
          { title: "LoRa Receiver", status: receiverStatus },
        ];

  const gpsLocked = hasGpsFix(data);
  const sats = data.sats ?? null;
  const linkRows: StatusRow[] = [
    loraLink === "connected"
      ? { title: "LoRa Link", status: STATUS.CONNECTED }
      : loraLink === "lost"
        ? { title: "LoRa Link", status: STATUS.DISCONNECTED, label: "No connection", alert: true }
        : { title: "LoRa Link", status: STATUS.DISCONNECTED },
    loraLink !== "connected"
      ? { title: "GPS Lock", status: STATUS.DISCONNECTED, label: "Unknown" }
      : gpsLocked
        ? { title: "GPS Lock", status: STATUS.CONNECTED, label: `Locked${sats !== null ? ` · ${sats} sats` : ""}` }
        : { title: "GPS Lock", status: STATUS.AWAITING, label: `No lock${sats !== null ? ` · ${sats} sats` : ""}` },
  ];
  const statusRows = [...connectionData, ...linkRows];

  const metrics: TMetric[] = [
    { title: "Temperature", value: formatTelemetryValue(data.Temp), unit: "°C" },
    { title: "Pressure", value: formatTelemetryValue(data.pressure), unit: "hPa" },
    // 0,0 means "no fix" from the receiver; the map keeps the last known position
    { title: "Latitude", value: formatTelemetryValue(gpsLocked ? data.lat : null, 6), unit: "°" },
    { title: "Longitude", value: formatTelemetryValue(gpsLocked ? data.lon : null, 6), unit: "°" },
  ];

  return (
    <div className="w-full max-w-xs space-y-8">
      <div className="space-y-8">
        {metrics.map((metric) => (
          <Metric key={metric.title} metrics={metric}></Metric>
        ))}
        <SignalIndicator
          rssi={data.rssi ?? null}
          snr={data.snr ?? null}
          live={loraLink === "connected"}
        />
      </div>


      <div className="space-y-6">
        {statusRows.map((connection, index) => (
          <div key={`{connection}-${index}`} className="flex items-center">
            {/* Icon */}
            <svg
              className={`w-6 h-6 fill-current ${connection.alert ? "text-red" : getIconColor(connection.status)}`}
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 24C18.6274 24 24 18.6274 24 12C24 5.37258 18.6274 0 12 0C5.37258 0 0 5.37258 0 12C0 18.6274 5.37258 24 12 24ZM17.6647 10.1879C18.0446 9.78705 18.0276 9.15411 17.6268 8.77419C17.2259 8.39428 16.593 8.41125 16.2131 8.8121L10.8574 14.463L8.81882 12.3121C8.43891 11.9112 7.80597 11.8943 7.40512 12.2742C7.00427 12.6541 6.9873 13.287 7.36721 13.6879L10.1315 16.6046C10.3204 16.8038 10.5828 16.9167 10.8574 16.9167C11.1319 16.9167 11.3943 16.8038 11.5832 16.6046L17.6647 10.1879Z"
              />
            </svg>

            {/* Connection Details */}
            <div className="flex flex-col pl-3">
              <span className="text-xs font-bold text-gray-600 uppercase whitespace-nowrap">
                {connection.title}
              </span>
              <span
                className={`text-xs capitalize ${connection.alert ? "text-red font-bold" : getLabelColor(connection.status)}`}
              >
                {connection.label ?? connection.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default LeftPane;
