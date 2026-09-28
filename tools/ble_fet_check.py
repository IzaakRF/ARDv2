"""
Probe the undocumented binary 'FWT' packets from a Featherweight V2 ground station.

1) Capture raw bytes (no line splitting, no decoding):
     python fwt_probe.py capture --port /dev/tty.usbserial-XXXX --seconds 30 --out raw.bin

2) Search for known values (use the CORRECT lat/lon shown in the phone app,
   and also the wrong lat the text packets print):
     python fwt_probe.py search raw.bin --targets -33.9295 138.60513 -34.4294875459

Prints every frame offset + encoding where a target value appears. If the same
offset/encoding hits on every frame, you've found the field.
"""
import argparse
import struct
import time
from collections import Counter

MAGIC = b"FWT"


def capture(args):
    import serial
    end = time.time() + args.seconds
    total = 0
    with serial.Serial(args.port, args.baud, timeout=0.2) as ser, open(args.out, "wb") as f:
        while time.time() < end:
            data = ser.read(ser.in_waiting or 1)
            if data:
                f.write(data)
                total += len(data)
    print(f"Captured {total} bytes to {args.out}")


def split_frames(blob):
    parts = blob.split(MAGIC)
    return [MAGIC + p for p in parts[1:]]


CANDIDATES = []
for fmt, name in (("<f", "float32 LE"), (">f", "float32 BE"),
                  ("<d", "float64 LE"), (">d", "float64 BE")):
    CANDIDATES.append((fmt, 1.0, name))
for fmt, name in (("<i", "int32 LE"), (">i", "int32 BE")):
    for scale in (1e5, 1e6, 1e7, 1e3, 1e4, 1e8):
        CANDIDATES.append((fmt, scale, f"{name} /{scale:g}"))


def search(args):
    blob = open(args.file, "rb").read()
    frames = split_frames(blob)
    print(f"{len(frames)} FWT frames found")
    print("Frame length histogram:", dict(Counter(len(f) for f in frames).most_common(8)))

    hits = Counter()
    for fr in frames:
        for off in range(len(fr)):
            for fmt, scale, name in CANDIDATES:
                size = struct.calcsize(fmt)
                if off + size > len(fr):
                    continue
                try:
                    v = struct.unpack_from(fmt, fr, off)[0] / scale
                except struct.error:
                    continue
                for t in args.targets:
                    if abs(v - t) <= args.tol:
                        hits[(off, name, t)] += 1

    if not hits:
        print("No matches. Try a larger --tol, check the targets, or capture while the tracker has a fix.")
        return
    print("\nMatches (offset, encoding, target -> frames matched):")
    for (off, name, t), n in sorted(hits.items(), key=lambda x: -x[1]):
        print(f"  offset {off:3d}  {name:16s} target {t:<14} -> {n}/{len(frames)}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("capture")
    c.add_argument("--port", required=True)
    c.add_argument("--baud", type=int, default=115200)
    c.add_argument("--seconds", type=float, default=30)
    c.add_argument("--out", default="raw.bin")
    c.set_defaults(fn=capture)

    s = sub.add_parser("search")
    s.add_argument("file")
    s.add_argument("--targets", type=float, nargs="+", required=True)
    s.add_argument("--tol", type=float, default=0.0005)
    s.set_defaults(fn=search)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()