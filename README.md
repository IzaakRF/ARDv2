# Adept Rocketry Ground Station

## Hardware

- Teensy 4.1
- LoRa Module

## Libraries

- RadioHead
- LiquidCrystal I2C (Frank de Brabander)

## Circuit schematic

![Groundstation circuit schematic](embedded/resources/GroundStation.png)


## Serial data packet structure

```c
struct TelemetryPacket {
  uint32_t time;                   // 4 bytes
  float altitude;                  // 4 bytes
  float bmpTemp;                   // 4 bytes
  float imuTemp;                   // 4 bytes
  float pressure;                  // 4 bytes
  float accX, accY, accZ;          // 12 bytes
  float gyroX, gyroY, gyroZ; // 12 bytes
  float lat, lon
} __attribute__((packed));         // Ensure no padding in the structure
```

Refer to [Telemetry.hpp](embedded/core/Telemetry.hpp) for the packet structure and shared utility functions.


## GUI

### Telemetry (Active)
![Telemetry Active](images/gui-images/telemetry-active.png)

### Telemetry (Inactive)
![Telemetry](images/gui-images/telemetry.png)

### GUI Graphs
![Graphs](images/gui-images/graphs.png)

### Settings
![Settings](images/gui-images/settings.png)

## About

Adept Rocketry Division's Groundstation. This repo consists of a web-based GUI  and the embedded system code which resides on the teensy microcontroller.

## Getting Started

The GUI can read telemetry from either a Web Serial connection or a WebSocket connection. The included Raspberry Pi receiver reads the inAir9B directly over SPI and serves valid telemetry packets over WebSocket. It is receive-only: it does not transmit LoRa packets or accept commands from WebSocket clients.

The GUI supports two telemetry sources:

- **SRAD:** 12-field CSV telemetry containing time, temperature, pressure, altitude, acceleration, angular velocity, latitude, and longitude. The GUI stores and exports altitude in feet. A line may carry four optional status fields after the 12: `rssi` (dBm), `snr` (dB), `sats` (GPS satellites) and `gpsFix` (1/0). The ESP32 receiver for the Telemetry Board sends them; they drive the **Signal** (dBm) indicator and the **LoRa Link** and **GPS Lock** status. Lat/lon of `0,0` means no GPS fix.
- **COTS Feather:** `GPS_STAT` packets containing latitude, longitude, and altitude in feet. Unavailable sensor values are shown as `--.--`.

On the Settings page you can:

- Select SRAD or COTS Feather parsing.
- Select Serial or WebSocket as the connection type.
- Configure the WebSocket URL, which defaults to `ws://localhost:8765`.
- Change and apply the launch-site latitude and longitude.
- Export the collected telemetry history as a timestamped CSV file.

The map uses local satellite tiles over an offline OpenStreetMap street map (committed in `gui/public/basemap`, covering White Cliffs, Caradoc Station and the Goodwood test area), and supports an interactive elevated flight-path overlay. It follows the rocket by default (dragging the map turns this off), and shows LoRa link and GPS lock status. Satellite tiles can be downloaded for a chosen center coordinate and radius with the offline map downloader, which writes them into `gui/public/maps` (not committed). See [offlinemap/README.md](offlinemap/README.md).

**LoRa Link** shows "No connection" when the transport is connected but no telemetry has arrived for 6 s (the Telemetry Board sends a packet every 2 s).

### Raspberry Pi LoRa Receiver

Connect the inAir9B to the Raspberry Pi's 3.3 V SPI pins. The current receiver uses:

| inAir9B | Raspberry Pi |
| --- | --- |
| SCK | GPIO11 / physical pin 23 |
| MISO | GPIO9 / physical pin 21 |
| MOSI | GPIO10 / physical pin 19 |
| NSS / CS | CE1 / GPIO7 / physical pin 26 |
| DIO0 | GPIO18 / physical pin 12 |
| RESET | GPIO12 / physical pin 32 |
| 3.3V | 3.3V / physical pin 17 |
| GND | GND |

Enable SPI with `sudo raspi-config` under **Interface Options**, then install the Python dependencies:

```bash
cd LoRa
python3 -m venv .venv
source .venv/bin/activate
pip install adafruit-blinka spidev raspi-lora==0.2 websockets
cd ..
```

Run the receiver on the Raspberry Pi:

```bash
python3 LoRa/Lora_receiver_firmware.py
```

The receiver uses CE1 (SPI channel 1) for NSS, GPIO18 for the inAir9B DIO0
interrupt, and GPIO12 for RESET by default. If the reset wire uses a different
BCM GPIO, pass it explicitly:

```bash
python3 LoRa/Lora_receiver_firmware.py --reset-pin <BCM_RESET_PIN>
```

Pass `--debug` to enable detailed radio, packet, and WebSocket diagnostics.

It listens for 12-field numeric telemetry at 915 MHz and serves it at `ws://localhost:8765`. Use `--frequency 868` for an 868 MHz inAir9B and `--host 0.0.0.0` when the GUI runs on another computer. The receiver must use the same frequency and radio settings as the transmitter.

The receiver contains no LoRa send call and no WebSocket command handling. Keep the inAir9B antenna connected whenever the transmitter is operating; receive-only software cannot protect a separate transmitter from antenna-less operation.

View receiver logs with `journalctl -u ard-lora-receiver.service -f`. The service
user must have access to SPI and GPIO devices; add it to the `gpio` and `spi`
groups if those groups exist on the Raspberry Pi:

```bash
sudo usermod -aG gpio,spi pi
```

Log out and back in, or reboot, after changing group membership.

### ESP32 Serial Bridge

For an ESP32 that already receives LoRa and prints telemetry over USB serial, install the bridge dependencies and run:

```bash
pip install pyserial websockets
python3 tools/serial_websocket_bridge.py \
  --serial-port /dev/cu.usbserial-DK0JXP7Q \
  --baud 115200
```

Then select **WebSocket** in the GUI and use `ws://localhost:8765`.

### Default Configuration

GUI startup defaults are centralized in [gui/src/config.ts](gui/src/config.ts). Edit this file when deploying the ground station to a different launch site or telemetry setup:

```ts
export const DEFAULT_CONFIG = {
  launchSite: {
    latitude: -33.0305768,
    longitude: 136.3780941,
  },
  connection: {
    transport: "serial",
    websocketUrl: "ws://localhost:8765",
    baudRate: 115200,
  },
  dataSource: "cots",
};
```

Configuration fields:

- `launchSite.latitude` and `launchSite.longitude` set the initial map center and launch-site form values. Coordinates use decimal degrees.
- `connection.transport` selects the initial `serial` or `websocket` connection mode.
- `connection.websocketUrl` sets the initial WebSocket address when WebSocket mode is selected.
- `connection.baudRate` sets the Web Serial baud rate.
- `dataSource` selects the initial parser: `srad` or `cots`.

These are startup defaults. Settings changed through the GUI are not written back to the config file and reset when the application reloads.

Information on setting up the GUI is available in its README. Embedded-system details are documented below.

### GUI

[Gui README](gui/README.md)


```bash
# deploy manually 
cd gui
npm install gh-pages --save-dev
npm run deploy


## Features

- [x] Real-time telemetry data
- [x] Graphs page
- [x] Settings page
- [x] Deploy to github pages
- [x] Teensy System Integration
- [x] Offline satellite map with flight-path visualization
- [x] SRAD and COTS Feather telemetry sources
- [x] Web Serial and WebSocket telemetry connections
- [x] CSV flight-data export
- [ ] More robust disconnect mechanism (disconnect regardless of connection failure)
- [ ] Database to save past flights
- [ ] Responsive UI (Gui can be used on phones/tablets)
