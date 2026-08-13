"""Generate Axon's monochrome app icon from one simple axon silhouette."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "assets"
SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# The field stays black; the mark is one axon fibre travelling left-to-right,
# ending in a small terminal arbor. It remains legible at Windows' 16px size.
draw.rounded_rectangle((20, 20, 492, 492), radius=112, fill=(0, 0, 0, 255))

def curve(points, width=24):
    samples = []
    for i in range(121):
        t = i / 120
        u = 1 - t
        x = sum(c * v for c, v in zip((u**3, 3*u*u*t, 3*u*t*t, t**3), (points[0][0], points[1][0], points[2][0], points[3][0])))
        y = sum(c * v for c, v in zip((u**3, 3*u*u*t, 3*u*t*t, t**3), (points[0][1], points[1][1], points[2][1], points[3][1])))
        samples.append((x, y))
    draw.line(samples, fill=(255, 255, 255, 255), width=width, joint="curve")

# Soma / axon hillock, a single fibre, and three terminal branches.
draw.ellipse((55, 205, 137, 287), fill=(255, 255, 255, 255))
curve(((119, 246), (174, 197), (228, 297), (299, 241)), 25)
curve(((292, 241), (342, 198), (367, 211), (412, 158)), 18)
curve(((293, 241), (348, 242), (372, 251), (438, 243)), 18)
curve(((293, 241), (339, 290), (372, 289), (413, 333)), 18)
for x, y in ((416, 154), (442, 242), (417, 337)):
    draw.ellipse((x - 17, y - 17, x + 17, y + 17), fill=(255, 255, 255, 255))

# Nodes of Ranvier: short black breaks make the fibre unmistakably axonal.
for x, y in ((165, 235), (214, 250), (263, 256)):
    draw.line((x - 5, y - 16, x + 5, y + 16), fill=(0, 0, 0, 255), width=7)

img.save(OUT / "icon.png", "PNG", optimize=True)
img.save(OUT / "icon.ico", "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
