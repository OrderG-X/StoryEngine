# 生成应用图标（P11）：accent 底色圆角方块 + 「书」字，和界面左上角的品牌小方块一个样。
# 字体用 Noto Serif SC Bold（SIL OFL，可以画进图标）：
#   https://github.com/notofonts/noto-cjk/raw/main/Serif/SubsetOTF/SC/NotoSerifSC-Bold.otf
# 用法：python3 make-icon.py <NotoSerifSC-Bold.otf> icon.png
#   再用 sips 出 16～1024 各尺寸、iconutil -c icns 合成 icon.icns（Mac 用）；icon.png 给 Windows。
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
font_path, out = sys.argv[1], sys.argv[2]
N = 1024
SS = 4  # 超采样，边缘更顺
W = N * SS
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
# macOS 图标网格：824 见方的圆角方块，四周留 100
inset, size, radius = 100 * SS, 824 * SS, 185 * SS
# 阴影
shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([inset, inset + 12 * SS, inset + size, inset + size + 12 * SS], radius, fill=(0, 0, 0, 90))
shadow = shadow.filter(ImageFilter.GaussianBlur(14 * SS))
img.alpha_composite(shadow)
# 底色：accent 竖向渐变（上亮下深）
top, bottom = (232, 190, 135), (200, 146, 88)
grad = Image.new("RGBA", (1, size))
for y in range(size):
    t = y / (size - 1)
    grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
grad = grad.resize((size, size))
mask = Image.new("L", (size, size), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
img.paste(grad, (inset, inset), mask)
# 字：「书」，accent-ink
font = ImageFont.truetype(font_path, 500 * SS)
d = ImageDraw.Draw(img)
bbox = d.textbbox((0, 0), "书", font=font)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (W - w) / 2 - bbox[0]
y = (W - h) / 2 - bbox[1] + 6 * SS
d.text((x, y), "书", font=font, fill=(32, 23, 12, 255))
img = img.resize((N, N), Image.LANCZOS)
img.save(out)
