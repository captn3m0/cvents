"""Dump the string table of a Hermes v98 bytecode bundle as JSON lines."""
import json
import struct
import sys


def align(pos, n=4):
    return pos + (-pos % n)


def main(path, out):
    buf = open(path, "rb").read()
    magic, version = struct.unpack_from("<QI", buf, 0)
    assert version == 98, version
    names = [
        "fileLength", "globalCodeIndex", "functionCount", "stringKindCount",
        "identifierCount", "stringCount", "overflowStringCount",
        "stringStorageSize", "bigIntCount", "bigIntStorageSize", "regExpCount",
        "regExpStorageSize", "literalValueBufferSize", "objKeyBufferSize",
        "objShapeTableCount", "numStringSwitchImms", "segmentID",
        "cjsModuleCount", "functionSourceCount", "debugInfoOffset",
    ]
    h = dict(zip(names, struct.unpack_from("<20I", buf, 32)))
    pos = 128 + h["functionCount"] * 12
    pos = align(pos) + h["stringKindCount"] * 4
    pos = align(pos) + h["identifierCount"] * 4
    small = struct.unpack_from(f"<{h['stringCount']}I", buf, align(pos))
    pos = align(pos) + h["stringCount"] * 4
    over = struct.unpack_from(f"<{h['overflowStringCount'] * 2}I", buf, align(pos))
    pos = align(pos) + h["overflowStringCount"] * 8
    storage = align(pos)
    with open(out, "w") as f:
        for i, e in enumerate(small):
            utf16, off, ln = e & 1, (e >> 1) & 0x7FFFFF, e >> 24
            if ln == 0xFF:
                off, ln = over[off * 2], over[off * 2 + 1]
            raw = buf[storage + off: storage + off + ln * (2 if utf16 else 1)]
            s = raw.decode("utf-16-le", "surrogatepass") if utf16 else raw.decode("latin-1")
            f.write(json.dumps({"i": i, "s": s}, ensure_ascii=False) + "\n")
    print(json.dumps(h), file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
