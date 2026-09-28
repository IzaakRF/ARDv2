"""
Decode position from the (undocumented) binary FWT frames of a Featherweight V2 ground station.
Reverse-engineered from one capture: NOT an official format.

Usage:
  python decode_fwt.py raw.bin                                   # decode a capture file
  python decode_fwt.py --live --port /dev/tty.usbserial-XXXX     # decode live from the ground station
"""
import argparse
import re
import struct

ID_LEN = 11  # length of e.g. "GPSTrk06851"


def decode_fwt(frame: bytes, id_len: int = ID_LEN):
    """frame starts with b'FWT'. Returns (id, lat, lon, alt_ft) or None."""
    if not frame.startswith(b"FWT") or len(frame) < 9 + id_len + 12:
        return None
    ident = frame[9:9 + id_len]
    if not re.fullmatch(rb"[A-Za-z0-9_\-]+", ident):
        return None
    lat, lon, alt_mm = struct.unpack_from("<iii", frame, 9 + id_len)
    lat, lon = lat / 1e7, lon / 1e7
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lon == 0:  # other frame types reuse the ID header but carry no position
        return None
    return ident.decode(), lat, lon, alt_mm / 304.8


def frames_from(blob: bytes):
    """Split a byte stream into candidate FWT frames (each ends at CRLF)."""
    for m in re.finditer(rb"FWT.*?\r\n", blob, re.S):
        yield m.group(0)


def run_file(path, id_len):
    blob = open(path, "rb").read()
    n = 0
    for fr in frames_from(blob):
        r = decode_fwt(fr, id_len)
        if r:
            n += 1
            print(f"{r[0]}  lat {r[1]:.7f}  lon {r[2]:.7f}  alt {r[3]:.1f} ft")
    print(f"\n{n} position frames decoded")


def run_live(port, baud, id_len):
    import serial
    buf = b""
    with serial.Serial(port, baud, timeout=0.5) as ser:
        try:
            while True:
                buf += ser.read(ser.in_waiting or 1)
                # keep only from the last complete frame boundary onward
                while True:
                    m = re.search(rb"FWT.*?\r\n", buf, re.S)
                    if not m:
                        break
                    r = decode_fwt(m.group(0), id_len)
                    if r:
                        print(f"{r[0]}  lat {r[1]:.7f}  lon {r[2]:.7f}  alt {r[3]:.1f} ft")
                    buf = buf[m.end():]
                buf = buf[-2000:]  # don't grow forever
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?", help="raw capture file (e.g. raw.bin)")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--port")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--id-len", type=int, default=ID_LEN,
                    help="characters in the tracker ID (default 11)")
    a = ap.parse_args()

    if a.live:
        if not a.port:
            ap.error("--live needs --port")
        run_live(a.port, a.baud, a.id_len)
    elif a.file:
        run_file(a.file, a.id_len)
    else:
        ap.error("give a capture file or use --live")
