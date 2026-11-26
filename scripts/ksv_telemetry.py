#!/usr/bin/env python3
"""Decode KartRider KSV replays into source-neutral telemetry JSON.

This is a self-contained copy of the reference decoder used by the drift
reference pipeline.  Quaternion components are stored in KSV files at 1/10000
scale; they are normalized here before deriving the body heading.

`heading` is the kart body forward direction in the replay's horizontal plane
and `yaw` is kept as a compatibility alias carrying the same corrected value.
The old z-axis Euler-angle "yaw" is not used because it does not match the
kart's forward vector.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import zlib
from datetime import datetime, timedelta
from pathlib import Path


def adler32_initial_zero(data: bytes) -> int:
    first = 0
    second = 0
    for value in data:
        first = (first + value) % 65521
        second = (second + first) % 65521
    return (second << 16) | first


HEADER_CLASS_IDS = {
    adler32_initial_zero(f"KartRecord{version}Header".encode()): version
    for version in range(15)
}
RECORD_CLASS_IDS = {
    adler32_initial_zero(f"KartRecord{version}".encode()): version
    for version in range(15)
}

SPEED_NAMES = ["normal", "fast", "fastest", "slow", "no-limit"]
CONTEST_NAMES = [
    "invalid",
    "speed-individual",
    "item-individual",
    "speed-team",
    "item-team",
    "speed-school",
    "item-school",
    "flag-team",
    "flag-individual",
    "time-attack",
]
GAS_NAMES = ["", "red-nitro", "blue-nitro", "mini-boost", "front-boost",
             "gas-101", "gas-110", "boost"]
CHARACTER_NAMES = ["", "lean-left", "lean-right", "head-hit", "reverse-head",
                   "reverse-left", "reverse-right", "head-collision"]
EFFECT_NAMES = ["", "boost-effect", "drift-effect", "drift-boost"]

QUATERNION_SCALE = 0.0001


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.offset = 0

    def take(self, length: int) -> bytes:
        end = self.offset + length
        if end > len(self.data):
            raise ValueError(f"KSV truncated at {self.offset}: need {length} bytes")
        value = self.data[self.offset:end]
        self.offset = end
        return value

    def u8(self) -> int:
        return self.take(1)[0]

    def i16(self) -> int:
        return struct.unpack("<h", self.take(2))[0]

    def u16(self) -> int:
        return struct.unpack("<H", self.take(2))[0]

    def i32(self) -> int:
        return struct.unpack("<i", self.take(4))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def utf16(self) -> str:
        length = self.i32()
        if length < 0:
            raise ValueError(f"Negative KSV string length {length}")
        return self.take(length * 2).decode("utf-16-le")

    def date(self) -> datetime:
        days = self.u16()
        quarter_hours = self.u16()
        return datetime(1900, 1, 1) + timedelta(days=days, seconds=quarter_hours * 4)


def decode_kr_data(data: bytes) -> bytes:
    reader = Reader(data)
    total_length = reader.i32()
    payload = reader.take(total_length)
    if payload[0] != 0x53:
        raise ValueError("Not a KartRider KRData payload")
    mode = payload[1]
    expected_hash = struct.unpack_from("<I", payload, 2)[0]
    offset = 6
    encrypted = bool(mode & 2)
    compressed = bool(mode & 1)
    key = 0
    if encrypted:
        key = struct.unpack_from("<I", payload, offset)[0]
        offset += 4
    decompressed_size = 0
    if compressed:
        decompressed_size = struct.unpack_from("<i", payload, offset)[0]
        offset += 4
    body = payload[offset:]
    if encrypted:
        extended = bytearray()
        current = (key ^ 0x8473FBC1) & 0xFFFFFFFF
        for _ in range(16):
            extended += struct.pack("<I", current)
            current = (current - 0x7B8C043F) & 0xFFFFFFFF
        body = bytes(value ^ extended[index & 63] for index, value in enumerate(body))
    if compressed:
        body = zlib.decompress(body)
        if len(body) != decompressed_size:
            raise ValueError(
                f"KSV decompressed size {len(body)} != {decompressed_size}"
            )
    actual_hash = adler32_initial_zero(body)
    if actual_hash != expected_hash:
        raise ValueError(
            f"KSV hash mismatch: {actual_hash:08x} != {expected_hash:08x}"
        )
    return body


def normalize_quaternion(
    w: float, x: float, y: float, z: float
) -> tuple[float, float, float, float]:
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    if norm == 0.0:
        return 0.0, 0.0, 0.0, 0.0
    return w / norm, x / norm, y / norm, z / norm


def quaternion_heading(w: float, x: float, y: float, z: float) -> float:
    """Return body heading in radians, measured from +y toward +x."""
    w, x, y, z = normalize_quaternion(w, x, y, z)
    fx = -2.0 * (x * y - w * z)
    fy = -(1.0 - 2.0 * (x * x + z * z))
    return math.atan2(fx, fy)


def decode_samples(reader: Reader, header_version: int) -> list[dict]:
    samples = []
    while reader.offset < len(reader.data):
        if reader.offset + 18 > len(reader.data):
            raise ValueError(f"KSV record tail has {len(reader.data) - reader.offset} bytes")
        time_tick = reader.i16()
        x = reader.i16() * 0.1
        y = reader.i16() * 0.1
        z = reader.i16() * 0.1
        qw = reader.i16() * QUATERNION_SCALE
        qx = reader.i16() * QUATERNION_SCALE
        qy = reader.i16() * QUATERNION_SCALE
        qz = reader.i16() * QUATERNION_SCALE
        qw, qx, qy, qz = normalize_quaternion(qw, qx, qy, qz)
        heading = quaternion_heading(qw, qx, qy, qz)
        status = reader.u16()
        gas = status & 7
        character = (status >> 3) & 7
        effect = (status >> 6) & 3
        samples.append({
            "tick": time_tick,
            "x": x,
            "y": y,
            "z": z,
            "qw": qw,
            "qx": qx,
            "qy": qy,
            "qz": qz,
            "heading": heading,
            "yaw": heading,
            "status": status,
            "gas": gas,
            "gasName": GAS_NAMES[gas],
            "character": character,
            "characterName": CHARACTER_NAMES[character],
            "effect": effect,
            "effectName": EFFECT_NAMES[effect],
            "drifting": effect in (2, 3),
            "boosting": gas in (1, 2, 3, 4, 7),
        })
    return samples


def read_player(reader: Reader, header_version: int) -> dict:
    player_name = reader.utf16()
    club_name = reader.utf16()
    equipment = {}
    equipment["character"] = reader.i16()
    if header_version >= 10:
        equipment["kartPaint"] = reader.i16()
    equipment["characterColor"] = reader.i16()
    equipment["kart"] = reader.i16()
    equipment["plate"] = reader.i16()
    equipment["goggle"] = reader.i16()
    equipment["balloon"] = reader.i16()
    equipment["equ2"] = reader.i16()
    equipment["headband"] = reader.i16()
    equipment["replay"] = reader.i16()
    equipment["cane"] = reader.i16()
    equipment["equ3"] = reader.i16()
    equipment["apparel"] = reader.i16()
    equipment["equ4"] = reader.i16()
    equipment["plateText"] = reader.utf16()
    for key in ("equ5", "equ6", "equ7", "equ8", "equ9", "equ10", "equ11"):
        equipment[key] = reader.i16()
    if header_version >= 11:
        equipment["equ12"] = reader.i16()
        equipment["equ13"] = reader.i16()
    return {"name": player_name, "club": club_name, "equipment": equipment}


def decode_ksv(path: Path) -> dict:
    reader = Reader(decode_kr_data(path.read_bytes()))
    header_class = reader.u32()
    if header_class not in HEADER_CLASS_IDS:
        raise ValueError(f"Unknown KSV header class {header_class:08x}")
    header_version = HEADER_CLASS_IDS[header_class]
    title = reader.utf16()
    region = reader.i16()
    unknown_1_1 = reader.u8()
    contest = reader.u8()
    player_name_hash = reader.u32()
    unknown_1_2 = reader.u32()
    recorder_account = reader.utf16()
    recorder_name = reader.utf16()
    recording_date = reader.date()
    record_checksum = reader.u32()
    is_official = reader.u8() == 1
    description = reader.utf16()
    track_name = reader.utf16()
    unknown_3 = reader.i32()
    best_time_ms = reader.i32()
    contest_image = reader.utf16()
    unknown_4 = reader.i32()
    unknown_5 = reader.i32()
    unknown_6 = reader.u8()
    speed = reader.u8() if header_version >= 9 else 0
    # Header v12 writes an extra byte before the player count. Its value has
    # matched the player count in every recovered replay, but it is not read by
    # the reference KartLibrary parser for earlier versions.
    if header_version >= 12:
        reader.u8()
    player_count = reader.i32()
    players = [read_player(reader, header_version) for _ in range(player_count)]

    record_class = reader.u32()
    if record_class not in RECORD_CLASS_IDS:
        raise ValueError(f"Unknown KSV record class {record_class:08x}")
    record_version = RECORD_CLASS_IDS[record_class]
    record_count = reader.i32()
    records = []
    for index in range(record_count):
        stamp_count = reader.i32()
        samples = decode_samples(Reader(reader.take(stamp_count * 18)), header_version)
        if index < len(players):
            name = players[index]["name"]
        else:
            name = f"player-{index + 1}"
        drift_frames = sum(1 for sample in samples if sample["drifting"])
        records.append({
            "index": index,
            "player": name,
            "sampleCount": len(samples),
            "firstTick": samples[0]["tick"] if samples else None,
            "lastTick": samples[-1]["tick"] if samples else None,
            "driftFrames": drift_frames,
            "samples": samples,
        })

    return {
        "source": str(path),
        "headerVersion": header_version,
        "recordVersion": record_version,
        "title": title,
        "region": region,
        "unknown1_1": unknown_1_1,
        "contest": contest,
        "contestName": CONTEST_NAMES[contest] if contest < len(CONTEST_NAMES) else "unknown",
        "playerNameHash": player_name_hash,
        "unknown1_2": unknown_1_2,
        "recorderAccount": recorder_account,
        "recorderName": recorder_name,
        "recordingDate": recording_date.isoformat(),
        "recordChecksum": record_checksum,
        "official": is_official,
        "description": description,
        "trackName": track_name,
        "unknown3": unknown_3,
        "bestTimeMs": best_time_ms,
        "contestImage": contest_image,
        "unknown4": unknown_4,
        "unknown5": unknown_5,
        "unknown6": unknown_6,
        "speed": speed,
        "speedName": SPEED_NAMES[speed] if speed < len(SPEED_NAMES) else "unknown",
        "players": players,
        "records": records,
    }


def summary(replay: dict) -> dict:
    return {
        "source": replay["source"],
        "track": replay["trackName"],
        "contest": replay["contestName"],
        "speed": replay["speedName"],
        "date": replay["recordingDate"],
        "bestTimeMs": replay["bestTimeMs"],
        "players": [player["name"] for player in replay["players"]],
        "records": [
            {
                "player": record["player"],
                "samples": record["sampleCount"],
                "driftFrames": record["driftFrames"],
                "start": record["firstTick"],
                "end": record["lastTick"],
            }
            for record in replay["records"]
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()

    files: list[Path] = []
    for input_path in args.inputs:
        if input_path.is_dir():
            files.extend(sorted(input_path.glob("*.ksv")))
        else:
            files.append(input_path)
    if not files:
        raise SystemExit("No KSV files found")

    replays = [decode_ksv(path) for path in files]
    if args.summary:
        payload = [summary(replay) for replay in replays]
    else:
        payload = replays
    text = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


if __name__ == "__main__":
    main()
