import { useEffect, useRef, useState } from "react";
import LeftPane from "./components/LeftPane";
import RightPane from "./components/RightPane";
import { DEFAULT_TELEMETRY_DATA, PAGE, STATUS, Telemetry } from "./types";
import TelemetryPage from "./pages/TelemetryPage";
import SettingsPage from "./pages/SettingsPage";
import GraphPage from "./pages/GraphPage";
import MapPage from "./pages/MapPage";
import { DEFAULT_CONFIG } from "./config";

// With the telemetry board alternating GPS and flight computer packets, the
// receiver forwards a sample about every 2 s. No sample for this long while
// connected means the LoRa link is down.
const LORA_LINK_TIMEOUT_MS = 6000;

import backgroundImageFile from '@/assets/background-cropped.png';

function App() {
  const [page, setPage] = useState<PAGE>(PAGE.TELEMETRY);
  const [portStatus, setPortStatus] = useState<STATUS>(STATUS.DISCONNECTED);
  const [transport, setTransport] = useState<"serial" | "websocket">(
    DEFAULT_CONFIG.connection.transport,
  );
  const [healthStatus, setHealthStatus] = useState<
    "unknown" | "checking" | "healthy" | "starting" | "unavailable"
  >("unknown");
  const [telemetryData, setTelemetryData] = useState<Telemetry[]>([
    DEFAULT_TELEMETRY_DATA,
  ]);
  const [launchSite, setLaunchSite] = useState<[number, number]>([
    DEFAULT_CONFIG.launchSite.longitude,
    DEFAULT_CONFIG.launchSite.latitude,
  ]);
  const [targetHeight, setTargetHeight] = useState<number>(
    DEFAULT_CONFIG.targetAltitude,
  );

  // Track when telemetry last arrived, for the LoRa link status
  const [lastSampleAt, setLastSampleAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sampleCountRef = useRef(telemetryData.length);
  useEffect(() => {
    if (telemetryData.length > sampleCountRef.current) {
      setLastSampleAt(Date.now());
    }
    sampleCountRef.current = telemetryData.length;
  }, [telemetryData.length]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (portStatus !== STATUS.CONNECTED) setLastSampleAt(null);
  }, [portStatus]);

  const loraLink: "connected" | "lost" | "offline" =
    portStatus !== STATUS.CONNECTED
      ? "offline"
      : lastSampleAt !== null && now - lastSampleAt < LORA_LINK_TIMEOUT_MS
        ? "connected"
        : "lost";

  const latest =
    telemetryData[telemetryData.length - 1] || DEFAULT_TELEMETRY_DATA;
  const time = latest.time;
  const altitude = latest.altitude;

  const settingsView = (
    <SettingsPage
      portStatus={portStatus}
      setPortStatus={setPortStatus}
      telemetryData={telemetryData}
      setTelemetryData={setTelemetryData}
      launchSite={launchSite}
      setLaunchSite={setLaunchSite}
      targetHeight={targetHeight}
      setTargetHeight={setTargetHeight}
      onTransportChange={setTransport}
      onHealthStatusChange={setHealthStatus}
    />
  );

  const renderView = () => {
    switch (page) {
      case PAGE.SETTINGS:
        return null;
      case PAGE.GRAPHS:
        return <GraphPage data={telemetryData} />;
      case PAGE.MAP:
        return (
          <MapPage data={telemetryData} launchSite={launchSite} loraLink={loraLink} />
        );
      default:
        return (
          <TelemetryPage
            time={time}
            altitude={altitude}
            gyroX={latest.gyroX}
            gyroY={latest.gyroY}
            gyroZ={latest.gyroZ}
          />
        );
    }
  };

  return (
    <div className="w-full h-screen font-sans bg-cover bg-gradient-to-b from-blue-950  bg-blue-900"
    style={{
      backgroundImage:
        page === PAGE.TELEMETRY ? `url(${backgroundImageFile})` : "none",
        backgroundPosition: "-10rem center",
      backgroundRepeat: "repeat", 
    }}
    >
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-black/30 to-transparent" />
      
      
      <header className="fixed top-0 left-0 right-0 shadow px-8 lg:px-16 py-8 z-10">
        <nav className="flex flex-row space-x-16">
          {Object.values(PAGE).map((item) => (
            <div
              key={item}
              onClick={() => setPage(item as PAGE)}
              className={`text-md font-bold rounded cursor-pointer hover:text-blue-100 ${
                page === item ? "text-white" : "text-gray-300"
              }`}
            >
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </div>
          ))}
        </nav>
      </header>

      <div
        className="relative w-full h-full pt-16"
      >
        <div className="flex flex-row h-full">
          <div className="px-8 lg:px-16 py-8">
            <LeftPane
              data={latest}
              serial_status={portStatus}
              transport={transport}
              healthStatus={healthStatus}
              loraLink={loraLink}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6 md:px-8">
            <div className={page === PAGE.SETTINGS ? "contents" : "hidden"}>
              {settingsView}
            </div>
            {renderView()}
          </div>
          <div className="px-8 lg:px-16 py-8">
            <RightPane
              data={latest}
              history={telemetryData}
              targetHeight={targetHeight}
              showGyro={page !== PAGE.TELEMETRY}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

