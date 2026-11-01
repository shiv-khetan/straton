"""MkDocs hook: render the HTTP route table from the engine's auth contract test.

The contract test (crates/straton-engine/src/api_contract_tests.rs) lists every /v1 route
and fails when a registered route is missing, so the docs can never drift from the code.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "crates/straton-engine/src/api_contract_tests.rs"
MARKER = "<!-- api-routes -->"


def _routes():
    text = SOURCE.read_text(encoding="utf-8")
    table = text[text.index("const ROUTES") :]
    table = table[: table.index("];")]
    return re.findall(r'\("([A-Z]+)",\s*"([^"]+)"\)', table)


def on_page_markdown(markdown, page, **_):
    if MARKER not in markdown:
        return markdown
    groups = {}
    for method, path in _routes():
        groups.setdefault(path.split("/")[2], []).append((method, path))
    out = []
    for group in sorted(groups):
        out.append(f"### `{group}`\n\n| Method | Path |\n| --- | --- |")
        for method, path in sorted(groups[group], key=lambda r: (r[1], r[0])):
            out.append(f"| `{method}` | `{path}` |")
        out.append("")
    return markdown.replace(MARKER, "\n".join(out))
