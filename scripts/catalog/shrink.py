import sys, os
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src); im.load()
w,h = im.size
if max(w,h) > 512:
    s = 512/max(w,h); im = im.resize((round(w*s), round(h*s)), Image.LANCZOS)
im = im.convert('RGBA') if im.mode in ('RGBA','LA','P') and 'transparency' in im.info or im.mode in ('RGBA','LA') else im.convert('RGB')
im.save(dst, optimize=True)
if os.path.getsize(dst) > 300_000:
    q = im.convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG) if im.mode=='RGB' else im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)
    q.save(dst, optimize=True)
print(os.path.basename(dst), im.size, os.path.getsize(dst))
