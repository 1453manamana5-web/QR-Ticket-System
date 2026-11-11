#!/usr/bin/env python3
"""Render mature, natural Japanese female speech for offline reception announcements.

Run on updates only; visitors' devices never call an online speech API.
Requires edge-tts and ffmpeg. All existing chime WAV files remain unchanged.
"""
import asyncio
import subprocess
import tempfile
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]
SOUNDS = ROOT / "reception-app" / "public" / "sounds"
VOICE = "ja-JP-NanamiNeural"
RATE = "-3%"
PITCH = "-10Hz"

TRACKS = (
    ("entry_osusumi_voice_d_v1.mp3", "お進みください。", None),
    ("entry_success_voice_d_v1.mp3", "お進みください。", "qr_result_chime.wav"),
    ("exit_thank_you_voice_d_v1.mp3", "ご来場ありがとうございました。", None),
    ("exit_success_voice_d_v1.mp3", "ご来場ありがとうございました。", "qr_result_chime.wav"),
    ("error_retry_guidance_d_v1.mp3", "やり直してください。", None),
    ("error_retry_result_d_v1.mp3", "やり直してください。", "qr_gate_error_chime_v1.wav"),
)


def render(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="reception-voice-") as temp:
        staging = Path(temp)
        recorded: dict[str, Path] = {}
        for _, phrase, _ in TRACKS:
            if phrase in recorded:
                continue
            source = staging / f"speech-{len(recorded)}.mp3"
            await edge_tts.Communicate(phrase, VOICE, rate=RATE, pitch=PITCH).save(str(source))
            if source.stat().st_size < 1500:
                raise RuntimeError(f"Invalid synthesis for: {phrase}")
            recorded[phrase] = source

        for file, phrase, chime in TRACKS:
            output = staging / file
            voice_file = recorded[phrase]
            if chime:
                # Keep the existing success/error chime intact and give the voice room to begin.
                render(
                    "-i", str(SOUNDS / chime), "-i", str(voice_file),
                    "-filter_complex",
                    "[0:a]aresample=48000,apad=pad_dur=0.10[c];"
                    "[1:a]aresample=48000[v];"
                    "[c][v]concat=n=2:v=0:a=1[out]",
                    "-map", "[out]", "-ac", "1", "-ar", "48000", "-b:a", "128k",
                    str(output),
                )
            else:
                render(
                    "-i", str(voice_file), "-ac", "1", "-ar", "48000", "-b:a", "128k",
                    str(output),
                )
            if output.stat().st_size < 1500:
                raise RuntimeError(f"Invalid output: {file}")

        # Render all assets before replacing any of the originals.
        for file, _, _ in TRACKS:
            (staging / file).replace(SOUNDS / file)
        for file, phrase, chime in TRACKS:
            print(f"OK: {file} | {phrase} | chime={chime or 'none'}")


if __name__ == "__main__":
    asyncio.run(main())
