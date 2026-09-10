"""Build NoCLI.ai's native Windows icon from the flat barrier-over-CLI mark."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src" / "assets"
icon = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(icon)
draw.rounded_rectangle((20, 20, 492, 492), radius=112, fill="#101216")

# The app name already supplies “No”; the mark is the part being blocked.
font = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 174)
text = "CLI"
box = draw.textbbox((0, 0), text, font=font, stroke_width=0)
draw.text(((512 - (box[2] - box[0])) / 2 - box[0], 166 - box[1]), text, font=font, fill="white")
draw.rectangle((94, 261, 418, 303), fill="#4EA1FF")
icon.save(ASSETS / "icon.png", "PNG", optimize=True)
icon.save(ASSETS / "icon.ico", "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
