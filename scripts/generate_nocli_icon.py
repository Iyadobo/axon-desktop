"""Build Calcium's native app icon from the bone mark.

The bone is the product identity: a white bone on black. This crops the source
art to a centred square, downsamples to 512px, and writes the PNG used for the
window/tray plus the multi-resolution Windows ICO used by the installer.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src" / "assets"

src = Image.open(ASSETS / "calcium-bone.png").convert("RGB")
w, h = src.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
square = src.crop((left, top, left + side, top + side)).resize((512, 512), Image.LANCZOS)

square.save(ASSETS / "icon.png", "PNG", optimize=True)
square.save(
    ASSETS / "icon.ico",
    "ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote icon.png and icon.ico from calcium-bone.png")
