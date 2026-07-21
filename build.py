#!/usr/bin/env python3
"""
build.py — упаковщик в один HTML.
Берёт index.html + css/style.css + все js/*.js,
снимает import/export, раскладывает каждый модуль в IIFE
(чтобы не было коллизий имён `state`, `dom`, и т.п.),
и записывает self-contained ./salience.html.

Использование:
    python build.py
или просто двойной клик по build.bat.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent

# Файлы в порядке зависимостей
JS_FILES = [
    'js/algorithms/util.js',
    'js/algorithms/blur.js',
    'js/algorithms/color.js',
    'js/algorithms/fft.js',
    'js/algorithms/ft.js',
    'js/algorithms/dog.js',
    'js/algorithms/local.js',
    'js/algorithms/sr.js',
    'js/algorithms/index.js',
    'js/colormap.js',
    'js/metrics.js',
    'js/render.js',
    'js/loader.js',
    'js/export.js',
    'js/toast.js',
    'js/app.js',
    'js/modes/single.js',
    'js/modes/compare.js',
    'js/modes/match.js',
]

# Файлы для отдельного бандла айтрекинг-модуля fixations.html
FIX_JS_FILES = [
    'js/algorithms/util.js',
    'js/algorithms/blur.js',
    'js/algorithms/color.js',
    'js/algorithms/fft.js',
    'js/algorithms/ft.js',
    'js/algorithms/dog.js',
    'js/algorithms/local.js',
    'js/algorithms/sr.js',
    'js/algorithms/index.js',
    'js/colormap.js',
    'js/metrics.js',
    'js/render.js',
    'js/loader.js',
    'js/export.js',
    'js/toast.js',
    'js/eyetracking/csv-parser.js',
    'js/eyetracking/fixmap.js',
    'js/fixations-app.js',
]

# Что каждый модуль публикует наружу (в window)
EXPORTS = {
    'js/algorithms/util.js':    ['normalize'],
    'js/algorithms/blur.js':    ['gaussBlur1D'],
    'js/algorithms/color.js':   ['rgbToLab', 'rgbToGray', 'rgbChannels'],
    'js/algorithms/fft.js':     ['fft1d', 'fft2d'],
    'js/algorithms/ft.js':      ['ftSaliency'],
    'js/algorithms/dog.js':     ['dogSaliency'],
    'js/algorithms/local.js':   ['localContrastSaliency'],
    'js/algorithms/sr.js':      ['spectralResidualSaliency'],
    'js/algorithms/index.js':   ['computeSaliency', 'METHOD_LABELS'],
    'js/colormap.js':           ['jet', 'hot', 'gray', 'getColormap', 'colormapLegendDataURL'],
    'js/metrics.js':            ['computeMetrics', 'METRIC_LABELS', 'METHOD_DESC', 'pearsonR', 'formatMetric'],
    'js/render.js':             ['renderHeatmap', 'renderOverlay', 'canvasToBlob'],
    'js/loader.js':             ['loadImageFile', 'loadImageFiles', 'cropToImageData', 'TARGET_SIZE'],
    'js/export.js':             ['toCSV', 'downloadCSV', 'downloadBlob', 'downloadCanvasPNG',
                                 'jsZipAvailable', 'downloadZip', 'stripExt'],
    'js/toast.js':              ['toast', 'toastError', 'toastSuccess', 'toastInfo'],
    'js/app.js':                ['getSettings', 'onSettingsChange'],
    'js/modes/single.js':       ['initSingleMode'],
    'js/modes/compare.js':      ['initCompareMode'],
    'js/modes/match.js':        ['initMatchMode'],
    'js/eyetracking/csv-parser.js': ['parseCSV', 'detectColumns', 'extractFixations', 'uniqueStimuli'],
    'js/eyetracking/fixmap.js':     ['buildFixationMap', 'pearsonR', 'computeNSS', 'computeAUCJudd', 'differenceMap', 'TARGET'],
    'js/fixations-app.js':          [],  # точка входа, всё в DOMContentLoaded
}


def strip_modules(text: str) -> str:
    """Снимает import/export."""
    # import {...} from '...'  (в т.ч. многострочные с переносами в фигурных скобках)
    text = re.sub(
        r"^[ \t]*import\s+\{[^}]*\}\s*from\s+['\"][^'\"]+['\"]\s*;?[ \t]*\n?",
        '',
        text,
        flags=re.M | re.S,
    )
    # import default from '...'
    text = re.sub(
        r"^[ \t]*import\s+\w+\s+from\s+['\"][^'\"]+['\"]\s*;?[ \t]*\n?",
        '',
        text,
        flags=re.M,
    )
    # import '...'
    text = re.sub(
        r"^[ \t]*import\s+['\"][^'\"]+['\"]\s*;?[ \t]*\n?",
        '',
        text,
        flags=re.M,
    )
    # снять префикс export перед function/const/let/var/class (в т.ч. async)
    text = re.sub(
        r"^([ \t]*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class))",
        r"\1",
        text,
        flags=re.M,
    )
    # export { ... };
    text = re.sub(
        r"^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*\n?",
        '',
        text,
        flags=re.M | re.S,
    )
    # export default ...
    text = re.sub(
        r"^([ \t]*)export\s+default\s+",
        r"\1",
        text,
        flags=re.M,
    )
    return text


def wrap_iife(file_label: str, body: str, exports: list[str]) -> str:
    expose_lines = '\n'.join(f"  window.{name} = {name};" for name in exports)
    indented = '\n'.join('  ' + line if line else '' for line in body.splitlines())
    return (
        f"/* ============= {file_label} ============= */\n"
        f"(function() {{\n"
        f"  'use strict';\n"
        f"{indented}\n"
        f"  // expose\n"
        f"{expose_lines}\n"
        f"}})();"
    )


def build_bundle(html_name: str, js_files: list[str], js_entry: str, out_name: str, css: str) -> bool:
    """Собирает один HTML-бандл. Возвращает True при успехе."""
    js_blocks = []
    for rel in js_files:
        path = ROOT / rel
        if not path.exists():
            print(f'ERROR: not found {path}', file=sys.stderr)
            return False
        content = path.read_text(encoding='utf-8')
        content = strip_modules(content)
        block = wrap_iife(rel, content, EXPORTS.get(rel, []))
        js_blocks.append(block)
    js_combined = '\n\n'.join(js_blocks)

    html_path = ROOT / html_name
    html = html_path.read_text(encoding='utf-8')

    css_repl = f'<style>\n{css}\n</style>'
    html, n_css = re.subn(
        r'<link\s+rel="stylesheet"\s+href="css/style\.css"\s*/?>',
        lambda _m: css_repl,
        html,
    )
    if n_css == 0:
        print(f'WARN: ссылка на style.css не найдена в {html_name}')

    js_repl = f'<script>\n{js_combined}\n</script>'
    pattern = rf'<script\s+type="module"\s+src="{re.escape(js_entry)}"\s*></script>'
    html, n_js = re.subn(pattern, lambda _m: js_repl, html)
    if n_js == 0:
        print(f'WARN: ссылка на {js_entry} не найдена в {html_name}')

    out = ROOT / out_name
    out.write_text(html, encoding='utf-8')
    size_kb = len(html.encode('utf-8')) / 1024
    print(f'OK: {out}  ({size_kb:.1f} КБ)')
    return True


def main() -> int:
    css_path = ROOT / 'css' / 'style.css'
    if not css_path.exists():
        print(f'ERROR: not found {css_path}', file=sys.stderr)
        return 1
    css = css_path.read_text(encoding='utf-8')

    # Бандл 1: основной модуль салиентности
    ok1 = build_bundle('index.html',     JS_FILES,     'js/app.js',            'salience.html',    css)
    # Бандл 2: айтрекинг-модуль (source: fixations.html, bundle: eyetracking.html)
    ok2 = build_bundle('fixations.html', FIX_JS_FILES, 'js/fixations-app.js',  'eyetracking.html', css)

    if not (ok1 and ok2):
        return 1

    print('\nГотово. Двойной клик по salience.html или fixations.html — работает без сервера.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
