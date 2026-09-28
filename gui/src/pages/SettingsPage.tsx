import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "@/components/ui/select";
import { DATA_COLUMNS, STATUS, Telemetry } from "@/types";
import {
  DataSource,
  FeatherweightTelemetryParser,
  parseCotsGpsTelemetry,
  parseTelemetryCsv,
  parseSradTelemetry,
} from "@/serialParsers";
import { DEFAULT_CONFIG } from "@/config";

type SettingsPageProps = {
  portStatus: STATUS;
  setPortStatus: React.Dispatch<React.SetStateAction<STATUS>>;
  telemetryData: Telemetry[];
  setTelemetryData: React.Dispatch<React.SetStateAction<Telemetry[]>>;
  launchSite: [number, number];
  setLaunchSite: React.Dispatch<React.SetStateAction<[number, number]>>;
  targetHeight: number;
  setTargetHeight: React.Dispatch<React.SetStateAction<number>>;
  onTransportChange: (transport: "serial" | "websocket") => void;
  onHealthStatusChange: (status: HealthStatus) => void;
};

type HealthStatus = "unknown" | "checking" | "healthy" | "starting" | "unavailable";

type HealthResponse = {
  service_running?: boolean;
  lora_connected?: boolean;
};

export default function SettingsPage({
  portStatus,
  setPortStatus,
  telemetryData,
  setTelemetryData,
  launchSite,
  setLaunchSite,
  targetHeight,
  setTargetHeight,
  onTransportChange,
  onHealthStatusChange,
}: SettingsPageProps) {
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [selectedPort, setSelectedPort] = useState<SerialPort | null>(null);
  const [rawData, setRawData] = useState<string>("");
  const [dataSource, setDataSource] = useState<DataSource>(DEFAULT_CONFIG.dataSource);
  const [transport, setTransport] = useState<"serial" | "websocket">(
    DEFAULT_CONFIG.connection.transport,
  );
  const [websocketUrl, setWebsocketUrl] = useState(
    DEFAULT_CONFIG.connection.websocketUrl,
  );
  const [replayPackets, setReplayPackets] = useState<Telemetry[]>([]);
  const [replayFileName, setReplayFileName] = useState("");
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [healthStatus, setHealthStatus] = useState<HealthStatus>("unknown");
  const [launchLongitude, setLaunchLongitude] = useState(String(launchSite[0]));
  const [launchLatitude, setLaunchLatitude] = useState(String(launchSite[1]));
  const [launchSiteMessage, setLaunchSiteMessage] = useState("");
  const [maxHeightInput, setMaxHeightInput] = useState(String(targetHeight));
  const [maxHeightMessage, setMaxHeightMessage] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null); 
  const fwtParserRef = useRef(new FeatherweightTelemetryParser());
  const websocketRef = useRef<WebSocket | null>(null);
  const streamStartTimeRef = useRef<number>(0);
  const replayTimerRef = useRef<number | null>(null);

  const isConnected = portStatus === STATUS.CONNECTED;
  const isSradWebSocket = transport === "websocket" && dataSource === "srad";

  useEffect(() => {
    onHealthStatusChange(healthStatus);
  }, [healthStatus, onHealthStatusChange]);

  useEffect(() => {
    if (!isSradWebSocket) {
      setHealthStatus("unknown");
      return;
    }

    let cancelled = false;
    const healthUrl = (() => {
      try {
        const url = new URL(websocketUrl);
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        url.port = "8080";
        url.pathname = "/health";
        url.search = "";
        return url.toString();
      } catch {
        return null;
      }
    })();

    const checkHealth = async () => {
      if (!healthUrl) {
        setHealthStatus("unavailable");
        return;
      }

      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
        const body = (await response.json()) as HealthResponse;
        if (!cancelled) {
          setHealthStatus(
            response.ok && body.lora_connected === true
              ? "healthy"
              : response.ok
                ? "starting"
                : "unavailable",
          );
        }
      } catch {
        if (!cancelled) {
          setHealthStatus("unavailable");
        }
      }
    };

    void checkHealth();
    const interval = window.setInterval(() => void checkHealth(), 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isSradWebSocket, websocketUrl]);

  const loadPorts = useCallback(async () => {
    try {
      console.log("INFO: Requesting serial ports");
      
      const port = await navigator.serial.requestPort();
  
      if (port) {
        setPorts([port]); 
        setPortStatus(STATUS.AWAITING);
        console.log("Selected port:", port);
      }
    } catch (err) {
      console.error("Error fetching ports:", err);
    }
  }, [setPortStatus]);
  

  const onSelectPort = (portId: string) => {
    const portObj = ports.find(
      (p) => String(p.getInfo().usbProductId) === portId
    );
    setSelectedPort(portObj || null);
  };

  const connectPort = useCallback(async () => {
    if (!selectedPort) return;
    setConnectionError("");
    fwtParserRef.current.reset();
    try {
        console.log("INFO: Connecting to port:", selectedPort);
      await selectedPort.open({ baudRate: DEFAULT_CONFIG.connection.baudRate });
      setPortStatus(STATUS.CONNECTED);
      streamStartTimeRef.current = Date.now();

      const reader = selectedPort.readable?.getReader();
      if (!reader) {
        throw new Error("Serial port opened without a readable stream");
      }
      readerRef.current = reader; 

      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;

        if (dataSource === "cots") {
          const parsed = fwtParserRef.current.push(
            value,
            Date.now() - streamStartTimeRef.current,
          );

          setRawData((previous) =>
            previous +
            parsed.text.join("\r\n") +
            parsed.binaryHex.map((frame) => `FWT ${frame}\r\n`).join(""),
          );
          parsed.warnings.forEach((warning) => console.warn(warning));
          parsed.telemetry.forEach((packet) => {
            setTelemetryData((previous) => [...previous, packet]);
          });
          continue;
        }

        buffer += new TextDecoder().decode(value);

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        setRawData((prev) => prev + buffer);

        for (const line of lines) {
          const packet = dataSource === "srad"
            ? parseSradTelemetry(line)
            : parseCotsGpsTelemetry(
                line,
                Date.now() - streamStartTimeRef.current,
              );

          if (packet) {
            setTelemetryData((prev) => [...prev, packet]);
          }
        }
      }

      if (readerRef.current === reader) {
        reader.releaseLock();
        readerRef.current = null;
      }
      try {
        await selectedPort.close();
      } catch (closeError) {
        console.error("Failed to close serial port after stream ended:", closeError);
      }
      setPortStatus(STATUS.DISCONNECTED);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to connect:", err);
      setConnectionError(message);

      if (readerRef.current) {
        try {
          await readerRef.current.cancel();
          readerRef.current.releaseLock();
        } catch (releaseError) {
          console.error("Failed to release serial reader:", releaseError);
        } finally {
          readerRef.current = null;
        }
      }

      try {
        await selectedPort.close();
      } catch (closeError) {
        console.error("Failed to close serial port after connection error:", closeError);
      }

      setPortStatus(STATUS.DISCONNECTED);
    }
  }, [dataSource, selectedPort, setPortStatus, setTelemetryData]);

  const connectWebSocket = useCallback(() => {
    if (websocketRef.current) return;

    try {
      const socket = new WebSocket(websocketUrl);
      websocketRef.current = socket;
      streamStartTimeRef.current = Date.now();

      socket.onopen = () => {
        setPortStatus(STATUS.CONNECTED);
      };

      socket.onmessage = (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        if (!text) return;

        setRawData((previous) => previous + text);
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

        for (const line of lines) {
          const packet = dataSource === "srad"
            ? parseSradTelemetry(line)
            : parseCotsGpsTelemetry(
                line,
                Date.now() - streamStartTimeRef.current,
              );

          if (packet) {
            setTelemetryData((previous) => [...previous, packet]);
          }
        }
      };

      socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        setPortStatus(STATUS.DISCONNECTED);
      };

      socket.onclose = () => {
        websocketRef.current = null;
        setPortStatus(STATUS.DISCONNECTED);
      };
    } catch (error) {
      console.error("Failed to connect to WebSocket:", error);
      websocketRef.current = null;
      setPortStatus(STATUS.DISCONNECTED);
    }
  }, [dataSource, setPortStatus, setTelemetryData, websocketUrl]);

  const disconnectPort = useCallback(async () => {
    if (transport === "websocket") {
      websocketRef.current?.close();
      websocketRef.current = null;
      setPortStatus(STATUS.DISCONNECTED);
      return;
    }

    if (!selectedPort) return;
    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
        readerRef.current.releaseLock();
        readerRef.current = null;
      }
      await selectedPort.close();
      setPortStatus(STATUS.DISCONNECTED);
    } catch (err) {
      console.error("Error closing port:", err);
      setPortStatus(STATUS.DISCONNECTED);
    }
  }, [selectedPort, setPortStatus, transport]);

  const applyLaunchSite = () => {
    const longitude = Number(launchLongitude);
    const latitude = Number(launchLatitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      setLaunchSiteMessage("Enter a valid latitude and longitude.");
      return;
    }

    setLaunchSite([longitude, latitude]);
    setLaunchSiteMessage("Launch site updated.");
  };

  const applyMaxHeight = () => {
    const height = Number(maxHeightInput);

    if (!Number.isFinite(height) || height <= 0) {
      setMaxHeightMessage("Enter a valid height in feet.");
      return;
    }

    setTargetHeight(height);
    setMaxHeightMessage("Max height updated.");
  };

  const exportTelemetryCsv = () => {
    const columns = DATA_COLUMNS.map(({ key }) => key);
    const csv = [
      columns.join(","),
      ...telemetryData.map((packet) =>
        columns.map((column) => packet[column]).join(",")
      ),
    ].join("\n");
    const filename = `telemetry-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const rawblob = new Blob([rawData], {type: "text/plain;charset=us-ascii"});
    const url = URL.createObjectURL(blob);
    const url2 = URL.createObjectURL(rawblob);
    const link = document.createElement("a");
    const link2 = document.createElement("a");
    link.href = url;
    link2.href = url2;
    link.download = filename;
    link2.download = `raw-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`
    link.click();
    link2.click();
    URL.revokeObjectURL(url);
    URL.revokeObjectURL(url2);

  };

  const clearReplayTimer = () => {
    if (replayTimerRef.current !== null) {
      window.clearTimeout(replayTimerRef.current);
      replayTimerRef.current = null;
    }
  };

  const replayNextPacket = useCallback((index: number) => {
    if (index >= replayPackets.length) {
      setReplayPlaying(false);
      replayTimerRef.current = null;
      return;
    }

    const packet = replayPackets[index];
    setTelemetryData((previous) => [...previous, packet]);
    setReplayIndex(index + 1);

    const nextPacket = replayPackets[index + 1];
    if (!nextPacket) {
      setReplayPlaying(false);
      replayTimerRef.current = null;
      return;
    }

    const delay =
      nextPacket.time === null || packet.time === null
        ? 0
        : Math.max(0, (nextPacket.time - packet.time) / replaySpeed);
    replayTimerRef.current = window.setTimeout(
      () => replayNextPacket(index + 1),
      delay,
    );
  }, [replayPackets, replaySpeed, setTelemetryData]);

  const loadReplayFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    clearReplayTimer();
    setReplayPlaying(false);
    setReplayIndex(0);
    const packets = parseTelemetryCsv(await file.text());
    setReplayPackets(packets);
    setReplayFileName(file.name);
    setTelemetryData([]);
  };

  const startReplay = () => {
    if (replayPackets.length === 0) return;

    clearReplayTimer();
    if (replayIndex === 0) {
      setTelemetryData([]);
    }
    setReplayPlaying(true);
    replayNextPacket(replayIndex);
  };

  const pauseReplay = () => {
    clearReplayTimer();
    setReplayPlaying(false);
  };

  const stopReplay = () => {
    clearReplayTimer();
    setReplayPlaying(false);
    setReplayIndex(0);
    setTelemetryData([]);
  };

  useEffect(() => {
    if (selectedPort) {
      setPortStatus(STATUS.AWAITING);
    }
  }, [selectedPort, setPortStatus]);

  return (
    <div className="pt-8 px-4 sm:px-8 md:px-16">
      <div className="mb-6 rounded bg-slate-900/70 p-4 text-white">
        <p className="mb-3 font-semibold">Launch site</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Latitude
            <input
              type="number"
              min="-90"
              max="90"
              step="any"
              value={launchLatitude}
              onChange={(event) => setLaunchLatitude(event.target.value)}
              className="mt-1 w-full rounded border border-slate-400 px-3 py-2 text-black"
            />
          </label>
          <label className="text-sm">
            Longitude
            <input
              type="number"
              min="-180"
              max="180"
              step="any"
              value={launchLongitude}
              onChange={(event) => setLaunchLongitude(event.target.value)}
              className="mt-1 w-full rounded border border-slate-400 px-3 py-2 text-black"
            />
          </label>
        </div>
        <Button
          type="button"
          onClick={applyLaunchSite}
          className="mt-3 bg-yellow-500 text-white hover:bg-yellow-600"
        >
          Apply launch site
        </Button>
        {launchSiteMessage && (
          <p className="mt-2 text-sm text-slate-300">{launchSiteMessage}</p>
        )}
      </div>

      <div className="mb-6 rounded bg-slate-900/70 p-4 text-white">
        <p className="mb-3 font-semibold">Max height</p>
        <label className="text-sm">
          Target height (ft)
          <input
            type="number"
            min="0"
            step="any"
            value={maxHeightInput}
            onChange={(event) => setMaxHeightInput(event.target.value)}
            className="mt-1 w-full rounded border border-slate-400 px-3 py-2 text-black"
          />
        </label>
        <Button
          type="button"
          onClick={applyMaxHeight}
          className="mt-3 bg-yellow-500 text-white hover:bg-yellow-600"
        >
          Apply max height
        </Button>
        {maxHeightMessage && (
          <p className="mt-2 text-sm text-slate-300">{maxHeightMessage}</p>
        )}
      </div>

      <div className={dataSource === "replay" ? "hidden" : "mb-4"}>
        <p className="mb-2 font-semibold text-white">Connection type</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            onClick={() => {
              setTransport("serial");
              onTransportChange("serial");
            }}
            disabled={isConnected}
            className={transport === "serial"
              ? "bg-yellow-500 text-white hover:bg-yellow-600"
              : "bg-gray-700 text-white hover:bg-gray-800"}
          >
            Serial
          </Button>
          <Button
            type="button"
            onClick={() => {
              setTransport("websocket");
              onTransportChange("websocket");
            }}
            disabled={isConnected}
            className={transport === "websocket"
              ? "bg-yellow-500 text-white hover:bg-yellow-600"
              : "bg-gray-700 text-white hover:bg-gray-800"}
          >
            WebSocket
          </Button>
        </div>
        {transport === "websocket" && (
          <input
            type="text"
            value={websocketUrl}
            onChange={(event) => setWebsocketUrl(event.target.value)}
            disabled={isConnected}
            aria-label="WebSocket URL"
            className="mt-2 w-full rounded border border-slate-400 px-3 py-2 text-black"
            placeholder="ws://localhost:8765"
          />
        )}
      </div>

      <div className="mb-4">
        <p className="mb-2 font-semibold text-white">Data source</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            onClick={() => setDataSource("srad")}
            disabled={isConnected}
            className={dataSource === "srad"
              ? "bg-yellow-500 text-white hover:bg-yellow-600"
              : "bg-gray-700 text-white hover:bg-gray-800"}
          >
            SRAD
          </Button>
          <Button
            type="button"
            onClick={() => setDataSource("cots")}
            disabled={isConnected}
            className={dataSource === "cots"
              ? "bg-yellow-500 text-white hover:bg-yellow-600"
              : "bg-gray-700 text-white hover:bg-gray-800"}
          >
            COTS Feather
          </Button>
          <Button
            type="button"
            onClick={() => setDataSource("replay")}
            disabled={isConnected}
            className={dataSource === "replay"
              ? "bg-yellow-500 text-white hover:bg-yellow-600"
              : "bg-gray-700 text-white hover:bg-gray-800"}
          >
            CSV Replay
          </Button>
        </div>
        <p className="mt-2 text-sm text-gray-300">
          {dataSource === "srad"
            ? "12-field CSV telemetry"
            : dataSource === "cots"
              ? "GPS_STAT position telemetry; unavailable sensors display as --.--"
              : "Replay telemetry from an exported CSV file"}
        </p>
      </div>

      {dataSource === "replay" && (
        <div className="mb-4 rounded bg-slate-900/70 p-4 text-white">
          <p className="mb-3 font-semibold">CSV replay</p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={loadReplayFile}
            className="block w-full rounded border border-slate-400 bg-white px-3 py-2 text-black"
          />
          {replayFileName && (
            <p className="mt-2 text-sm text-slate-300">
              {replayFileName}: {replayPackets.length} packets
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={replayPlaying ? pauseReplay : startReplay}
              disabled={replayPackets.length === 0}
              className="bg-yellow-500 text-white hover:bg-yellow-600"
            >
              {replayPlaying ? "Pause" : "Play"}
            </Button>
            <Button
              type="button"
              onClick={stopReplay}
              disabled={replayPackets.length === 0}
              className="bg-gray-700 text-white hover:bg-gray-800"
            >
              Stop
            </Button>
            <label className="flex items-center gap-2 text-sm">
              Speed
              <select
                value={replaySpeed}
                onChange={(event) => setReplaySpeed(Number(event.target.value))}
                className="rounded border border-slate-400 px-2 py-2 text-black"
              >
                <option value="0.25">0.25x</option>
                <option value="1">1x</option>
                <option value="2">2x</option>
              </select>
            </label>
          </div>
        </div>
      )}

      <div className={dataSource === "replay" ? "hidden" : "block"}>
      {transport === "serial" && (
        <>
          <Select
            value={selectedPort ? String(selectedPort.getInfo().usbProductId) : ""}
            onValueChange={onSelectPort}
          >
            <SelectTrigger className="w-full text-black">
              <SelectValue placeholder="Select a serial port" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Serial Ports</SelectLabel>
                {ports.map((port, i) => {
                  const info = port.getInfo();
                  const portId = String(info.usbProductId);
                  return (
                    <SelectItem key={i} value={portId}>
                      USB PID: {portId} (VID: {info.usbVendorId})
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            </SelectContent>
          </Select>
        </>
      )}

      <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4 mt-4">
        {transport === "serial" && (
          <>
            <Button
              onClick={loadPorts}
              className="bg-gray-700 hover:bg-gray-800 w-full sm:w-auto"
            >
              Load Serial Ports
            </Button>

            <Button
              onClick={disconnectPort}
              className="bg-gray-700 hover:bg-gray-800 w-full sm:w-auto"
            >
              Clear ports
            </Button>
          </>
        )}
        <Button
          onClick={isConnected
            ? disconnectPort
            : transport === "websocket"
              ? connectWebSocket
              : connectPort}
          disabled={transport === "serial" && !selectedPort}
          className={`text-white w-full sm:w-auto ${
            transport === "websocket" || selectedPort
              ? "bg-yellow-500 hover:bg-yellow-600"
              : "bg-gray-400 cursor-not-allowed"
          }`}
        >
          {isConnected ? "Disconnect" : "Connect"}
        </Button>
      </div>
      </div>

      <div className="mt-16">
      <p>Port Status: {portStatus}</p>
        {connectionError && (
          <p className="text-red-400">Serial error: {connectionError}</p>
        )}
        {isSradWebSocket && (
          <p>
            LoRa receiver: {healthStatus === "healthy"
              ? "healthy"
              : healthStatus === "starting"
                ? "starting"
                : healthStatus === "checking"
                  ? "checking"
                  : healthStatus === "unavailable"
                    ? "unavailable"
                    : "--"}
          </p>
        )}

        <p>Raw Serial Data:</p>
        <pre className="mt-2 p-2 bg-gray-100 text-sm overflow-auto h-40 text-blue-900">
          {rawData}
        </pre>

        <p>Telemetry Data</p>
        <pre className="mt-2 p-2 bg-gray-100 text-sm overflow-auto h-80 text-blue-900">
          {JSON.stringify(telemetryData, null, 2)}
        </pre>
         <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4 mt-4"></div>
         <Button
          onClick={exportTelemetryCsv}
          disabled={telemetryData.length === 0}
          className="bg-blue-700 hover:bg-blue-800 w-full sm:w-auto"
        >
          Export CSV and Raw Data
        </Button>
      </div>
    </div>
  );
}
