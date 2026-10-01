// Minimal types for the vendored pmtiles bundle (only what MapPage uses).
import type { AddProtocolAction } from "maplibre-gl";

export class Protocol {
  constructor();
  tile: AddProtocolAction;
}
