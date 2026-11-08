#!/usr/bin/env python3
"""Create a synthetic 64 MiB / 256 chapter EPUB without accessing personal books."""
import argparse
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
args = parser.parse_args()
paragraph = '<p>这一章用来检验按需读取。大书只加载当前章节，不预先解压其余正文。阅读时，可以观察程序与 WebKit 辅助进程的内存变化。</p>'
body = paragraph * (256 * 1024 // len(paragraph.encode('utf8')))
with ZipFile(args.output, 'w', compression=ZIP_STORED) as z:
    z.writestr('mimetype', 'application/epub+zip')
    z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
    z.writestr('OPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>大书按需加载测试</dc:title><dc:creator>Leaf QA</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' + ''.join(f'<item id="c{i}" href="ch{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(256)) + '</manifest><spine>' + ''.join(f'<itemref idref="c{i}"/>' for i in range(256)) + '</spine></package>')
    z.writestr('OPS/nav.xhtml', '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>' + ''.join(f'<li><a href="ch{i}.xhtml">第 {i+1} 章</a></li>' for i in range(256)) + '</ol></nav></body></html>')
    for i in range(256):
        z.writestr(f'OPS/ch{i}.xhtml', f'<html><head><title>第 {i+1} 章</title></head><body><h1>第 {i+1} 章</h1>{body}</body></html>')
print(f'{args.output}: {args.output.stat().st_size / 1024 / 1024:.1f} MiB, 256 chapters')
