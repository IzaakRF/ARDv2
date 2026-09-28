import serial
import time
import json
import argparse
from datetime import datetime

# ==========================================
# CONFIGURATION
# ==========================================

# ANSI color codes for terminal readability
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'

def parse_gps_stat(parts):
    """Extracts position data from the GPS_STAT packet."""
    try:
        # Based on: @ GPS_STAT ... CRC_OK TRK secondTrk Alt 5655 lt 39.55612 ln -105.1032 Vel 0 -155 0 Fix 3 # 9
        unit_type = parts[8]
        alt = float(parts[parts.index("Alt") + 1])
        lat = float(parts[parts.index("lt") + 1])
        lon = float(parts[parts.index("ln") + 1])
        fix = int(parts[parts.index("Fix") + 1])
        sats = int(parts[parts.index("#") + 1])
        
        status = f"{Colors.GREEN}3D Lock{Colors.ENDC}" if fix >= 3 else f"{Colors.WARNING}Acquiring...{Colors.ENDC}"
        
        return f"{Colors.BLUE}[GPS: {unit_type}]{Colors.ENDC} {status} | Alt: {Colors.BOLD}{alt} ft{Colors.ENDC} | Lat: {lat}, Lon: {lon} | Sats: {sats}"
    except (ValueError, IndexError):
        return None

def parse_rx_nomtk(parts):
    """Extracts radio health and battery from normal tracker packets."""
    try:
        # Based on: @ RX_NOMTK ... PkRx 143 ... RSSI -124 SNR -20 ... trk_B_V 4102 -69 C
        sender_id = parts[8]
        rssi = int(parts[parts.index("RSSI") + 1])
        snr = int(parts[parts.index("SNR") + 1])
        
        # Battery might be formatted as 'trk_B_V 4102' (millivolts)
        batt_idx = parts.index("trk_B_V")
        batt_v = float(parts[batt_idx + 1]) / 1000.0
        
        return f"{Colors.HEADER}[RADIO: {sender_id}]{Colors.ENDC} RSSI: {rssi} dBm | SNR: {snr} dB | Tracker Batt: {Colors.BOLD}{batt_v:.2f} V{Colors.ENDC}"
    except (ValueError, IndexError):
        return None

def parse_fs_chnge(parts):
    """Extracts flight state changes."""
    try:
        # Based on: @ FS_CHNGE ... New commanded flight state: 0
        state = parts[parts.index("state:") + 1]
        return f"{Colors.FAIL}[FLIGHT STATE EVENT]{Colors.ENDC} Transitioned to state: {Colors.BOLD}{state}{Colors.ENDC}"
    except (ValueError, IndexError):
        return None

def parse_batt_ble(parts):
    """Extracts ground station battery and temperature."""
    try:
        # Based on: @ BATT_BLE 68 2020 5 17 0.176433519 4189 BLE+ 36 degC
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
    parser.add_argument(
        "--record",
        metavar="FILE",
        help="Append received telemetry packets to FILE for later replay/testing.",
        default="featherweight_record_file.txt",
    )
    args = parser.parse_args()
    PORT = "/dev/tty.usbserial-DK0JXP7Q"
    BAUD = 115200
    print(f"{Colors.BOLD}Starting Featherweight Live Telemetry on {PORT}...{Colors.ENDC}")
    print("Waiting for data...\n" + "="*50)

    record_file = open(args.record, "a", encoding="ascii") if args.record else None
    try:
        with serial.Serial(PORT, BAUD, timeout=1) as ser:
            while True:
                try:
                    # Wait for the start character to avoid binary data
                    if ser.read() == b'@' or True:
                        raw_packet = ser.readline()
                        clean_packet = raw_packet.decode('ascii', errors='ignore').rstrip('\r\n')

                        if record_file:
                            record_file.write(f"@{clean_packet}\n")
                            record_file.flush()

                        parts = clean_packet.split()

                        if not parts:
                            continue

                        packet_type = parts[0]
                        output = None

                        # Route to the correct parser
                        if packet_type == "GPS_STAT":
                            output = parse_gps_stat(parts)
                        elif packet_type == "RX_NOMTK" or packet_type == "RX_FOUND":
                            output = parse_rx_nomtk(parts)
                        elif packet_type == "FS_CHNGE":
                            output = parse_fs_chnge(parts)
                        elif packet_type == "BATT_BLE":
                            output = parse_batt_ble(parts)

                        # Print formatted string with timestamp if successfully parsed
                        if output:
                            timestamp = datetime.now().strftime("%H:%M:%S")
                            print(f"[{timestamp}] {output}")

                except KeyboardInterrupt:
                    print(f"\n{Colors.WARNING}Terminating connection.{Colors.ENDC}")
                    break
                except Exception as e:
                    # Catch unexpected serial disconnects or parse errors without crashing
                    pass
    finally:
        if record_file:
            record_file.close()

if __name__ == "__main__":
    main()