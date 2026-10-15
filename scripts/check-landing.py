#!/usr/bin/env python3
"""Verifications statiques de la vitrine c-pay.global (portal/landing, sans build).

    python3 scripts/check-landing.py [chemin-landing]

Pour chaque page HTML :
  - equilibre des balises (html.parser, elements vides ignores) ;
  - identifiants `id` dupliques ;
  - liens et ressources internes (href/src/action/srcset/poster) resolus comme nginx-landing.conf :
    `try_files $uri $uri/ $uri.html`, et ancres `#id` existantes dans la page cible ;
  - `<loc>` de sitemap.xml resolus.
Puis `node --check` sur chaque fichier JS (app.js, assistant.js, …).
Code de sortie 1 des qu'une erreur est trouvee. Stdlib uniquement.
"""
import os
import re
import subprocess
import sys
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
# Elements dont la fermeture peut etre implicite en HTML : on tolere leur omission
OPTIONAL_END = {'li', 'p', 'dt', 'dd', 'option', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'html', 'head', 'body'}
LINK_ATTRS = {'href', 'src', 'action', 'poster', 'data-src'}
SKIP_SCHEMES = ('http:', 'https:', 'mailto:', 'tel:', 'data:', 'javascript:', 'sms:', 'whatsapp:', '//')


class PageParser(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.stack = []
        self.ids = {}
        self.links = []   # (line, attr, value)
        self.errors = []

    def handle_starttag(self, tag, attrs):
        line = self.getpos()[0]
        attrs = dict(attrs)
        if tag not in VOID:
            self.stack.append((tag, line))
        if attrs.get('id') is not None:
            self.ids.setdefault(attrs['id'], []).append(line)
        for attr, value in attrs.items():
            if value is None:
                continue
            if attr in LINK_ATTRS:
                self.links.append((line, attr, value))
            elif attr == 'srcset':
                for part in value.split(','):
                    url = part.strip().split(' ')[0]
                    if url:
                        self.links.append((line, attr, url))

    def handle_startendtag(self, tag, attrs):
        # <tag/> : pas d'empilement
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        if tag in VOID:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                skipped = self.stack[i + 1:]
                for s_tag, s_line in skipped:
                    if s_tag not in OPTIONAL_END:
                        self.errors.append(f'{self.path}:{s_line}: <{s_tag}> non ferme avant </{tag}> (ligne {line})')
                del self.stack[i:]
                return
        self.errors.append(f'{self.path}:{line}: </{tag}> sans balise ouvrante')

    def finish(self):
        for tag, line in self.stack:
            if tag not in OPTIONAL_END:
                self.errors.append(f'{self.path}:{line}: <{tag}> jamais ferme')
        for ident, lines in self.ids.items():
            if len(lines) > 1:
                self.errors.append(f'{self.path}: id "{ident}" duplique (lignes {", ".join(map(str, lines))})')


def resolve(root, page_dir, target):
    """Resout un chemin comme nginx-landing.conf : $uri, $uri/ (index.html), $uri.html."""
    target = unquote(target)
    base = root if target.startswith('/') else page_dir
    candidate = os.path.normpath(os.path.join(base, target.lstrip('/') if target.startswith('/') else target))
    if not (candidate == root or candidate.startswith(root + os.sep)):
        return None
    if os.path.isfile(candidate):
        return candidate
    if os.path.isdir(candidate) and os.path.isfile(os.path.join(candidate, 'index.html')):
        return os.path.join(candidate, 'index.html')
    if os.path.isfile(candidate + '.html'):
        return candidate + '.html'
    return None


def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'portal', 'landing'))
    if not os.path.isdir(root):
        print(f'dossier introuvable : {root}')
        return 2
    pages = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git')]
        for name in filenames:
            if name.endswith('.html'):
                pages[os.path.join(dirpath, name)] = None

    errors = []
    for path in sorted(pages):
        parser = PageParser(os.path.relpath(path, root))
        with open(path, encoding='utf-8') as fh:
            parser.feed(fh.read())
        parser.close()
        parser.finish()
        pages[path] = parser
        errors.extend(parser.errors)

    # Liens internes + ancres
    checked = 0
    for path, parser in pages.items():
        rel = os.path.relpath(path, root)
        for line, attr, value in parser.links:
            value = value.strip()
            if not value or value.startswith(SKIP_SCHEMES) or value.startswith('{{'):
                continue
            parts = urlsplit(value)
            target_path, fragment = parts.path, parts.fragment
            if not target_path:
                target_page = path
            else:
                target_page = resolve(root, os.path.dirname(path), target_path)
                checked += 1
                if target_page is None:
                    errors.append(f'{rel}:{line}: {attr}="{value}" introuvable dans la vitrine')
                    continue
            if fragment and target_page in pages:
                if fragment not in pages[target_page].ids:
                    errors.append(f'{rel}:{line}: ancre #{fragment} absente de {os.path.relpath(target_page, root)}')

    # sitemap.xml
    sitemap = os.path.join(root, 'sitemap.xml')
    if os.path.isfile(sitemap):
        with open(sitemap, encoding='utf-8') as fh:
            for loc in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', fh.read()):
                loc_path = urlsplit(loc).path or '/'
                if resolve(root, root, loc_path) is None:
                    errors.append(f'sitemap.xml: {loc} ne correspond a aucune page')
                checked += 1

    # JS : node --check
    js_files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git')]
        js_files += [os.path.join(dirpath, f) for f in filenames if f.endswith('.js')]
    for js in sorted(js_files):
        proc = subprocess.run(['node', '--check', js], capture_output=True, text=True)
        if proc.returncode != 0:
            errors.append(f'{os.path.relpath(js, root)}: node --check\n{proc.stderr.strip()}')

    print(f'{len(pages)} page(s) HTML, {checked} lien(s)/ressource(s) internes, {len(js_files)} fichier(s) JS verifies ({os.path.relpath(root)})')
    if errors:
        print(f'{len(errors)} erreur(s) :')
        for e in errors:
            print('  - ' + e)
        return 1
    print('Vitrine OK.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
