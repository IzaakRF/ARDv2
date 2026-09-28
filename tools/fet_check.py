
import serial
import time
import argparse
from math import radians, sin, cos, asin, sqrt
from datetime import datetime

# ==========================================
# CONFIGURATION
# ==========================================
DEFAULT_PORT = "/dev/tty.usbserial-DK0JXP7Q"
DEFAULT_BAUD = 115200

# Position sanity check: reject a fix that moves further than this from the
# last accepted fix (allowing for elapsed time). Rockets are fast, but not
# 50 km-in-a-second fast.
JUMP_BASE_M = 500.0        # slack for normal GPS noise
JUMP_SPEED_MPS = 1000.0    # generous max speed
JUMP_ACCEPT_AFTER = 5      # after this many consecutive rejects, trust the new position


class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'


# ==========================================
# CRC CHECK  (CRC-16/BUYPASS: poly 0x8005, init 0, no reflect, no xorout)
# ==========================================
def crc16_buypass(data: bytes) -> int:
    crc = 0x0000
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x8005) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


# Standard check value for CRC-16/BUYPASS
assert crc16_buypass(b"123456789") == 0xFEE8


def packet_ok(packet: str) -> bool:
    """packet must include the leading '@'. Returns True only if the radio
    didn't flag CRC_ERR and the trailing CRC matches."""
    if "CRC_ERR" in packet:
        return False
    idx = packet.find("CRC:")
    if idx == -1:
        return False
    body = packet[:idx].rstrip()
    tail = packet[idx + 4:].split()
    if not tail:
        return False
    computed = crc16_buypass(body.encode("ascii", errors="ignore"))
    # Some packets (BATT_BLE) carry two hex values after "CRC:"; accept a match on any.
    for tok in tail:
        try:
            if int(tok, 16) == computed:
                return True
        except ValueError:
            continue
    return False


# ==========================================
# POSITION SANITY FILTER
# ==========================================
def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = radians(lat1), radians(lat2)
    dp = p2 - p1
    dl = radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * r * asin(sqrt(a))


class PositionFilter:
    """Tracks the last good position per unit and rejects impossible jumps."""

    def __init__(self):
        self.last = {}       # unit -> (lat, lon, t)
        self.rejects = {}    # unit -> consecutive reject count

    def accept(self, unit, lat, lon):
        now = time.monotonic()
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return False
        prev = self.last.get(unit)
        if prev is not None:
            plat, plon, pt = prev
            dist = haversine_m(plat, plon, lat, lon)
            limit = JUMP_BASE_M + JUMP_SPEED_MPS * (now - pt)
            if dist > limit:
                n = self.rejects.get(unit, 0) + 1
                self.rejects[unit] = n
                if n < JUMP_ACCEPT_AFTER:
                    return False
                # Repeated "jumps" -> the new position is probably the real one.
        self.rejects[unit] = 0
        self.last[unit] = (lat, lon, now)
        return True


# ==========================================
# PARSERS  (parts = packet without '@', split on whitespace)
# ==========================================
def value_after(parts, key, cast=str):
    return cast(parts[parts.index(key) + 1])


def parse_gps_stat(parts, pos_filter):
    """GPS_STAT packet. Returns a display string, or None if unparseable."""
    try:
        unit_type = parts[8]
        alt = value_after(parts, "Alt", float)
        lat = value_after(parts, "lt", float)
        lon = value_after(parts, "ln", float)
        fix = value_after(parts, "Fix", int)
        sats = value_after(parts, "#", int)
    except (ValueError, IndexError):
        return None

    tag = f"{Colors.BLUE}[GPS: {unit_type}]{Colors.ENDC}"

    if fix < 2:
        return f"{tag} {Colors.WARNING}Acquiring...{Colors.ENDC} | Sats: {sats}"

    if not pos_filter.accept(unit_type, lat, lon):
        return (f"{tag} {Colors.FAIL}Rejected position jump{Colors.ENDC} "
                f"(Lat: {lat}, Lon: {lon}) - ignoring")

    status = (f"{Colors.GREEN}3D Lock{Colors.ENDC}" if fix >= 3
              else f"{Colors.WARNING}2D Fix{Colors.ENDC}")
    return (f"{tag} {status} | Alt: {Colors.BOLD}{alt} ft{Colors.ENDC} | "
            f"Lat: {lat}, Lon: {lon} | Sats: {sats}")


def parse_rx(parts):
    """RX_NOMTK / RX_FOUND: radio health, plus tracker battery when present."""
    try:
        # Sender ID is the token just before "PkRx" (works for both packet types)
        sender_id = parts[parts.index("PkRx") - 1]
    except (ValueError, IndexError):
        sender_id = "?"

    try:
        if "RSSI" in parts:
            rssi = value_after(parts, "RSSI", int)
        else:
            rssi = value_after(parts, "p_RSSI", int)
    except (ValueError, IndexError):
        return None

    out = f"{Colors.HEADER}[RADIO: {sender_id}]{Colors.ENDC} RSSI: {rssi} dBm"

    if "SNR" in parts:
        try:
            out += f" | SNR: {value_after(parts, 'SNR', int)} dB"
        except (ValueError, IndexError):
            pass
    if "trk_B_V" in parts:
        try:
            batt_v = value_after(parts, "trk_B_V", float) / 1000.0
            out += f" | Tracker Batt: {Colors.BOLD}{batt_v:.2f} V{Colors.ENDC}"
        except (ValueError, IndexError):
            pass
    return out


def parse_fs_chnge(parts):
    try:
        state = value_after(parts, "state:")
        return (f"{Colors.FAIL}[FLIGHT STATE EVENT]{Colors.ENDC} "
                f"Transitioned to state: {Colors.BOLD}{state}{Colors.ENDC}")
    except (ValueError, IndexError):
        return None


def parse_batt_ble(parts):
    try:
        batt_mv = float(parts[6]) / 1000.0
        temp = parts[parts.index("degC") - 1]
        return f"{Colors.HEADER}[GS HEALTH]{Colors.ENDC} Batt: {batt_mv:.2f} V | Temp: {temp} °C"
    except (ValueError, IndexError):
        return None


# ==========================================
# MAIN LOOP
# ==========================================
def main():
    parser = argparse.ArgumentParser(description="Read and display live Featherweight telemetry.")
    parser.add_argument("--record", metavar="FILE", default="featherweight_record_file.txt",
                        help="Append every received text packet (good or bad) to FILE.")
    parser.add_argument("--port", default=DEFAULT_PORT, help="Serial port.")
    parser.add_argument("--baud", type=int, default=DEFAULT_BAUD, help="Baud rate.")
    parser.add_argument("--no-crc", action="store_true",
                        help="Disable CRC checking (not recommended).")
    parser.add_argument("--show-bad", action="store_true",
                        help="Print a note for each packet rejected by the CRC check.")
    args = parser.parse_args()

    print(f"{Colors.BOLD}Starting Featherweight Live Telemetry on {args.port}...{Colors.ENDC}")
    print("Waiting for data...\n" + "=" * 50)

    record_file = open(args.record, "a", encoding="ascii") if args.record else None
    pos_filter = PositionFilter()
    good = bad = 0

    try:
        while True:
            try:
                with serial.Serial(args.port, args.baud, timeout=1) as ser:
                    while True:
                        raw_packet = ser.readline()
                        if not raw_packet:
                            continue

                        line = raw_packet.decode('ascii', errors='ignore').strip()
                        at = line.find('@')
                        if at == -1:
                            continue            # binary/noise line
                        packet = line[at:]      # includes the '@'

                        # Record everything so bad packets can be inspected later
                        if record_file:
                            record_file.write(packet + "\n")
                            record_file.flush()

                        if not args.no_crc:
                            if not packet_ok(packet):
                                bad += 1
                                if args.show_bad:
                                    ts = datetime.now().strftime("%H:%M:%S")
                                    kind = packet[1:].split(maxsplit=1)[0] if len(packet) > 1 else "?"
                                    print(f"[{ts}] {Colors.WARNING}[CRC FAIL] {kind} "
                                          f"(good: {good}, bad: {bad}){Colors.ENDC}")
                                continue
                            good += 1

                        parts = packet[1:].split()
                        if not parts:
                            continue

                        packet_type = parts[0]
                        output = None

                        if packet_type == "GPS_STAT":
                            output = parse_gps_stat(parts, pos_filter)
                        elif packet_type in ("RX_NOMTK", "RX_FOUND"):
                            output = parse_rx(parts)
                        elif packet_type == "FS_CHNGE":
                            output = parse_fs_chnge(parts)
                        elif packet_type == "BATT_BLE":
                            output = parse_batt_ble(parts)

                        if output:
                            timestamp = datetime.now().strftime("%H:%M:%S")
                            print(f"[{timestamp}] {output}")

            except serial.SerialException as e:
                print(f"{Colors.WARNING}Serial error: {e}. Retrying in 2 s...{Colors.ENDC}")
                time.sleep(2)
            except KeyboardInterrupt:
                print(f"\n{Colors.WARNING}Terminating connection. "
                      f"CRC good: {good}, bad: {bad}{Colors.ENDC}")
                break
    finally:
        if record_file:
            record_file.close()


if __name__ == "__main__":
    main()