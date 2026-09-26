#!/usr/bin/env python3
"""Derive every icon file in the repository from the PNGs in icons/.

Run through `make icons`. icons/icon-<size>.png are the source: black
strokes on a transparent background. From them this makes

  macos/favicon.icns                        the app icon (as drawn)
  icons/icon-white-<size>.png               white strokes, for dark surfaces
  icons/icon-tile-<size>.png                white strokes on the site's ink tile,
                                            for favicons and Windows
  icons/RemoteVisio.ico                     the Windows sender's icon (tiles)
  macos/pkg/resources/background*.png       the installer's corner picture
  site/public/assets/{favicon-*,brand}.png  the landing site
  internal/web/favicon-*.png                the sender page served by the receiver
  cmd/sender-gui/icon.png                   the Windows sender's window icon

The menu-bar image is icon-16/icon-32 as they are (the app build copies
them as MenuIcon.png / MenuIcon@2x.png). A size that has no PNG of its own
is resampled from the largest one, so a larger master (ideally
icons/icon-1024.png) sharpens the big sizes automatically. Plain python plus
sips and iconutil, all part of macOS: no Pillow on a stock Mac.
"""
import glob
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

INK = (0x13, 0x14, 0x17)  # --ink of the landing site


def read_png(path):
    data = open(path, 'rb').read()
    pos, idat, w, h, ct = 8, [], 0, 0, 0
    while pos < len(data):
        n, = struct.unpack('>I', data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b'IHDR':
            w, h, depth, ct, _, _, interlace = struct.unpack('>IIBBBBB', body)
            if depth != 8 or ct not in (2, 6) or interlace:
                sys.exit(f'{path}: only 8-bit RGB/RGBA non-interlaced PNGs are handled')
        elif kind == b'IDAT':
            idat.append(body)
    bpp = 4 if ct == 6 else 3
    raw = zlib.decompress(b''.join(idat))
    stride = w * bpp
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        if bpp == 3:
            line = bytearray(b''.join(bytes(line[i:i + 3]) + b'\xff' for i in range(0, stride, 3)))
        rows.append(line)
    return w, h, rows


def png_bytes(w, h, rows):
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def white(rows):
    out = []
    for r in rows:
        line = bytearray(r)
        for i in range(0, len(line), 4):
            line[i:i + 3] = b'\xff\xff\xff'
        out.append(line)
    return out


def tile(rows):
    """White strokes over the opaque ink tile, alpha-blended."""
    out = []
    for r in rows:
        line = bytearray(len(r))
        for i in range(0, len(r), 4):
            a = r[i + 3]
            for k in range(3):
                line[i + k] = (255 * a + INK[k] * (255 - a)) // 255
            line[i + 3] = 255
        out.append(line)
    return out


def write_if_changed(path, data):
    """Leave the mtime alone when the bytes are the same: the receiver embeds
    some of these files and make rebuilds it when they look newer."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    if os.path.exists(path) and open(path, 'rb').read() == data:
        return
    with open(path, 'wb') as f:
        f.write(data)


def save(path, w, h, rows):
    write_if_changed(path, png_bytes(w, h, rows))


def main():
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    sizes = sorted(int(m.group(1)) for p in glob.glob('icons/icon-[0-9]*.png')
                   for m in [re.search(r'icon-(\d+)\.png$', p)] if m)
    if not sizes:
        sys.exit('no icons/icon-<size>.png files')
    largest = sizes[-1]
    work = tempfile.mkdtemp(prefix='remotevisio-icon.')
    try:
        def black(px):
            """The black source PNG at px pixels: the file itself, or a resample of the largest."""
            out = f'{work}/black-{px}.png'
            if os.path.exists(out):
                return out
            if os.path.exists(f'icons/icon-{px}.png'):
                shutil.copy(f'icons/icon-{px}.png', out)
            else:
                subprocess.run(['sips', '-s', 'format', 'png', '--resampleHeightWidth', str(px), str(px),
                                f'icons/icon-{largest}.png', '--out', out], check=True, stdout=subprocess.DEVNULL)
            return out

        iconset = f'{work}/RemoteVisio.iconset'
        os.mkdir(iconset)
        for slot in (16, 32, 128, 256, 512):
            shutil.copy(black(slot), f'{iconset}/icon_{slot}x{slot}.png')
            shutil.copy(black(slot * 2), f'{iconset}/icon_{slot}x{slot}@2x.png')
        subprocess.run(['iconutil', '-c', 'icns', '-o', f'{work}/favicon.icns', iconset], check=True)
        write_if_changed('macos/favicon.icns', open(f'{work}/favicon.icns', 'rb').read())

        variants = {}
        for px in (16, 32, 64, 96, 128, 256):
            w, h, rows = read_png(black(px))
            variants[px] = (rows, white(rows), tile(rows))
        for px in (32, 96):
            save(f'icons/icon-white-{px}.png', px, px, variants[px][1])
            save(f'icons/icon-tile-{px}.png', px, px, variants[px][2])
            save(f'site/public/assets/favicon-{px}.png', px, px, variants[px][2])
            save(f'internal/web/favicon-{px}.png', px, px, variants[px][2])
        save('site/public/assets/brand.png', 96, 96, variants[96][1])
        save('cmd/sender-gui/icon.png', 96, 96, variants[96][2])
        save('macos/pkg/resources/background.png', 128, 128, variants[128][0])
        save('macos/pkg/resources/background-dark.png', 128, 128, variants[128][1])

        # .ico: a directory of PNG-compressed images (Windows Vista and later).
        entries = [(px, png_bytes(px, px, variants[px][2])) for px in (16, 32, 64, 96, 256)]
        head = struct.pack('<HHH', 0, 1, len(entries))
        dirs, body = b'', b''
        offset = 6 + 16 * len(entries)
        for px, png in entries:
            dim = 0 if px >= 256 else px
            dirs += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset + len(body))
            body += png
        write_if_changed('icons/RemoteVisio.ico', head + dirs + body)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f'==> icons rebuilt from icons/ (largest source: {largest} px)')
    if largest < 1024:
        print('    a 1024 px icons/icon-1024.png would make the large sizes sharp')


if __name__ == '__main__':
    main()
