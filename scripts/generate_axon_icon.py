"""Build Axon's native Windows icon from the approved nervous-system mark.

The full-body artwork remains the in-app brand asset. Windows displays icons as
small as 16px, so the native treatment focuses on the brain, spine, and upper
body—the part that remains recognisable at taskbar scale.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src" / "assets"
source = Image.open(ASSETS / "axon-nervous-system.png").convert("RGBA")

# Keep the whole simplified CNS: a detailed brain plus its single straight
# spinal line. At taskbar scale this reads more clearly than a tight crop.
mark = source.copy()
mark.thumbnail((448, 448), Image.Resampling.LANCZOS)
icon = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
icon.alpha_composite(mark, ((512 - mark.width) // 2, (512 - mark.height) // 2))
icon.save(ASSETS / "icon.png", "PNG", optimize=True)
icon.save(ASSETS / "icon.ico", "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
