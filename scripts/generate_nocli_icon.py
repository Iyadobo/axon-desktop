"""Build NoCLI.ai's native Windows icon from the approved doorway mark."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src" / "assets"
source = Image.open(ASSETS / "nocli-mark-source.png").convert("RGBA")

# Keep the doorway intact and give it a small transparent margin for Windows.
mark = source.copy()
mark.thumbnail((448, 448), Image.Resampling.LANCZOS)
icon = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
icon.alpha_composite(mark, ((512 - mark.width) // 2, (512 - mark.height) // 2))
icon.save(ASSETS / "icon.png", "PNG", optimize=True)
icon.save(ASSETS / "icon.ico", "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
