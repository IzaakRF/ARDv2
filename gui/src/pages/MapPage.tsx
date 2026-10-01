import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { Map as MapLibreMap, type LngLatLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { hasGpsFix, Telemetry } from "@/types";
import { Protocol } from "@/vendor/pmtiles";
import basemapLayers from "@/basemap/layers";

const MAX_MAP_POINTS = 1000;
const MAP_BASE_URL = `${import.meta.env.BASE_URL}maps`;
const FEET_TO_METERS = 0.3048;

// Offline OpenStreetMap vector basemap (committed to git, see
// offlinemap/README.md). Covers White Cliffs NSW, Caradoc Station and the
// Goodwood test area; it shows wherever satellite tiles are missing.
const BASEMAP_URL = `${window.location.origin}${import.meta.env.BASE_URL}basemap/`;

let pmtilesProtocolAdded = false;

const basemapBelow = basemapLayers.filter((layer) => layer.type !== "symbol");
const basemapLabels = basemapLayers.filter((layer) => layer.type === "symbol");

const offlineStyle: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: `${BASEMAP_URL}fonts/{fontstack}/{range}.pbf`,
  sprite: `${BASEMAP_URL}sprites/v4/dark`,
  sources: {
    basemap: {
      type: "vector",
      url: `pmtiles://${BASEMAP_URL}whitecliffs_region.pmtiles`,
      attribution: "© OpenStreetMap contributors · Protomaps",
    },
    satellite: {
      type: "raster",
      tiles: [`${MAP_BASE_URL}/tiles/{z}/{x}/{y}.jpg`],
      tileSize: 256,
      attribution: "Satellite imagery: local launch-site dataset",
    },
  },
  // Street map underneath, satellite imagery on top where available, labels
  // above both
  layers: [
    ...basemapBelow,
    {
      id: "satellite",
      type: "raster",
      source: "satellite",
      paint: { "raster-opacity": 1 },
    },
    ...basemapLabels,
  ],
};

type MappableTelemetry = Telemetry & { lat: number; lon: number };

function isValidPoint(point: Telemetry): point is MappableTelemetry {
  return (
    point.lat !== null &&
    point.lon !== null &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180 &&
    (point.lat !== 0 || point.lon !== 0)
  );
}

function FlightPathOverlay({ map, points }: { map: MapLibreMap; points: MappableTelemetry[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const bounds = map.getContainer().getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = bounds.width * pixelRatio;
      canvas.height = bounds.height * pixelRatio;
      canvas.style.width = `${bounds.width}px`;
      canvas.style.height = `${bounds.height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);

      if (points.length === 0) return;

      const pixelsPerMeter =
        (256 * 2 ** map.getZoom()) /
        (40075017 * Math.cos((map.getCenter().lat * Math.PI) / 180));
      const altitudeScale = pixelsPerMeter * 0.45;
      const ground = points.map((point) => map.project([point.lon, point.lat]));
      const elevated = points.map((point, index) => ({
        x: ground[index].x,
        y:
          ground[index].y -
          Math.max(0, point.altitude ?? 0) * FEET_TO_METERS * altitudeScale,
      }));

      context.lineWidth = 2;
      context.strokeStyle = "rgba(255, 255, 255, 0.65)";
      context.setLineDash([5, 5]);
      context.beginPath();
      ground.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();
      context.setLineDash([]);

      context.lineWidth = 4;
      context.strokeStyle = "#ffbd2e";
      context.beginPath();
      elevated.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();

      context.lineWidth = 1;
      context.strokeStyle = "rgba(255, 189, 46, 0.7)";
      elevated.forEach((point, index) => {
        context.beginPath();
        context.moveTo(ground[index].x, ground[index].y);
        context.lineTo(point.x, point.y);
        context.stroke();
      });

      const latest = elevated[elevated.length - 1];
      context.fillStyle = "#ff4d4d";
      context.beginPath();
      context.arc(latest.x, latest.y, 7, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "white";
      context.lineWidth = 2;
      context.stroke();
    };

    map.on("render", draw);
    draw();
    return () => {
      map.off("render", draw);
    };
  }, [map, points]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10" />;
}

export default function MapPage({
  data,
  launchSite,
  loraLink,
}: {
  data: Telemetry[];
  launchSite: [number, number];
  loraLink: "connected" | "lost" | "offline";
}) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [hasMapTiles, setHasMapTiles] = useState(true);
  const [follow, setFollow] = useState(true);
  const [showImagery, setShowImagery] = useState(true);
  const mapPoints = data.filter(isValidPoint).slice(-MAX_MAP_POINTS);
  const latestPoint = mapPoints[mapPoints.length - 1];
  const latestSample = data[data.length - 1];
  const gpsLocked = latestSample ? hasGpsFix(latestSample) : false;
  const sats = latestSample?.sats ?? null;

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    if (!pmtilesProtocolAdded) {
      maplibregl.addProtocol("pmtiles", new Protocol().tile);
      pmtilesProtocolAdded = true;
    }

    const instance = new maplibregl.Map({
      container: mapContainerRef.current,
      style: offlineStyle,
      center: launchSite,
      zoom: 13,
      pitch: 55,
      bearing: -20,
      maxPitch: 75,
    });
    instance.addControl(new maplibregl.NavigationControl(), "top-right");
    console.info("[Map] satellite tiles:", `${MAP_BASE_URL}/tiles/{z}/{x}/{y}.jpg`);
    instance.on("error", (event) => {
      console.error("[MapLibre] map error event:", event);
      console.error("[MapLibre] underlying error:", event.error ?? event);
      if ("sourceId" in event && event.sourceId === "satellite") {
        setHasMapTiles(false);
      }
    });
    // Panning by hand stops following the rocket
    instance.on("dragstart", () => setFollow(false));
    instance.once("load", () => {
      console.info("[Map] style loaded successfully");
      setMap(instance);
    });
    mapRef.current = instance;

    return () => {
      instance.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (map) {
      map.easeTo({ center: launchSite, duration: 500 });
    }
  }, [launchSite, map]);

  // Rocket marker at its ground position; follow it when enabled
  useEffect(() => {
    if (!map || !latestPoint) return;
    const lngLat: [number, number] = [latestPoint.lon, latestPoint.lat];
    if (!markerRef.current) {
      const el = document.createElement("div");
      el.className = "h-5 w-5 rounded-full border-2 border-white shadow-lg";
      markerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .addTo(map);
    }
    markerRef.current.setLngLat(lngLat);
    // Red with a live fix and link, amber when it's the last known position
    markerRef.current.getElement().style.backgroundColor =
      gpsLocked && loraLink === "connected" ? "#E72D2D" : "#f59e0b";
    if (follow) {
      map.easeTo({ center: lngLat as LngLatLike, duration: 500 });
    }
  }, [map, latestPoint?.lat, latestPoint?.lon, follow, gpsLocked, loraLink]);

  useEffect(() => {
    if (!map) return;
    map.setLayoutProperty("satellite", "visibility", showImagery ? "visible" : "none");
  }, [map, showImagery]);

  const viewPath = () => {
    if (!map || mapPoints.length === 0) return;
    setFollow(false);
    const coordinates = mapPoints.map((point) => [point.lon, point.lat] as [number, number]);
    const bounds = coordinates.reduce(
      (result, coordinate) => result.extend(coordinate),
      new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
    );
    map.fitBounds(bounds, { padding: 80, pitch: 55, duration: 700, maxZoom: 16 });
  };

  return (
    <main className="relative h-full min-h-[34rem] overflow-hidden rounded-lg bg-slate-950">
      <div className="absolute inset-0">
        <div ref={mapContainerRef} className="h-full w-full" />
      </div>
      {map && <FlightPathOverlay map={map} points={mapPoints} />}

      <div className="pointer-events-none absolute left-4 top-4 z-20 max-w-xs rounded bg-slate-950/85 px-4 py-3 text-white shadow-lg">
        <p className="text-sm font-semibold">Flight map</p>
        <p className="mt-1 text-xs text-slate-300">
          {mapPoints.length} of {MAX_MAP_POINTS} map points
        </p>
        <p className={`mt-2 text-xs font-semibold ${
          loraLink === "connected" ? "text-green" : loraLink === "lost" ? "text-red" : "text-slate-400"
        }`}>
          LoRa: {loraLink === "connected" ? "connected" : loraLink === "lost" ? "NO CONNECTION" : "receiver offline"}
        </p>
        <p className={`mt-1 text-xs font-semibold ${
          loraLink !== "connected" ? "text-slate-400" : gpsLocked ? "text-green" : "text-yellow"
        }`}>
          GPS: {loraLink !== "connected"
            ? "unknown (no link)"
            : gpsLocked
              ? `locked${sats !== null ? ` · ${sats} sats` : ""}`
              : `no lock${sats !== null ? ` · ${sats} sats` : ""}`}
        </p>
        {latestPoint && (
          <p className="mt-1 font-mono text-xs text-slate-200">
            {latestPoint.lat.toFixed(6)}, {latestPoint.lon.toFixed(6)}
          </p>
        )}
        {!hasMapTiles && (
          <p className="mt-2 text-xs text-amber-300">
            No satellite imagery here; showing the offline street map.
          </p>
        )}
      </div>

      <div className="absolute bottom-4 left-4 z-20 flex gap-2">
        <button
          className={`rounded px-3 py-2 text-xs font-semibold ${
            follow ? "bg-yellow text-slate-950" : "bg-slate-950/90 text-white"
          }`}
          onClick={() => setFollow((value) => !value)}
        >
          Follow rocket: {follow ? "on" : "off"}
        </button>
        <button
          className="rounded bg-slate-950/90 px-3 py-2 text-xs font-semibold text-white"
          onClick={() => setShowImagery((value) => !value)}
        >
          Satellite: {showImagery ? "on" : "off"}
        </button>
        <button className="rounded bg-slate-950/90 px-3 py-2 text-xs font-semibold text-white" onClick={viewPath}>
          View path
        </button>
      </div>
    </main>
  );
}
