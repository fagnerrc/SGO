#!/usr/bin/env python3
"""Monta a prévia HTML do SGO e extrai o JavaScript inline para validação sintática."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
index = (ROOT / 'Index.html').read_text(encoding='utf-8')
styles = (ROOT / 'V10_Styles.html').read_text(encoding='utf-8')
core = (ROOT / 'V10_Core.html').read_text(encoding='utf-8')
assembled = index.replace("<?!= include('V10_Styles'); ?>", styles).replace("<?!= include('V10_Core'); ?>", core)
if '<?!=' in assembled:
    raise SystemExit('Falha: existe include de template não resolvido na prévia.')
(ROOT / 'Index_assembled_preview.NAO_USAR_EM_PRODUCAO.html').write_text(assembled, encoding='utf-8')
blocks = []
for match in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script>', assembled, re.I):
    attrs = match.group(1) or ''
    if re.search(r'\bsrc\s*=', attrs, re.I):
        continue
    blocks.append(match.group(2))
js = '\n\n/* ---- INLINE SCRIPT BLOCK ---- */\n\n'.join(blocks)
(ROOT / 'tests' / 'assembled_frontend.js').write_text(js, encoding='utf-8')
print(f'Prévia montada: {len(assembled.encode())} bytes; {len(blocks)} bloco(s) JavaScript inline.')
