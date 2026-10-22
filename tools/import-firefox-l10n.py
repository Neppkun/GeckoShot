"""Convert Firefox's Screenshots Fluent strings into Chrome _locales/*/messages.json.

Usage:
  python tools/import-firefox-l10n.py <firefox-src> <firefox-l10n>

<firefox-src>  checkout of https://github.com/mozilla-firefox/firefox (for en-US)
<firefox-l10n> checkout of https://github.com/mozilla-l10n/firefox-l10n

Only the handful of messages the extension uses are imported. Message ids map
to Chrome names by replacing "-" with "_"; attributes become "<id>_<attr>" ("__" would end a manifest __MSG_ name).
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

WANTED = {
    "screenshots.ftl": [
        "screenshot-toolbar-button",
        "screenshots-instructions",
        "screenshots-cancel-button",
        "screenshots-save-visible-button",
        "screenshots-save-page-button",
        "screenshots-too-large-error-title",
        "screenshots-too-large-error-details",
        "screenshots-component-retry-button",
        "screenshots-component-cancel-button",
        "screenshots-component-copy-button-2",
        "screenshots-component-download-button-2",
        "screenshots-component-download-key",
        "screenshots-component-copy-key",
        "screenshots-overlay-selection-region-size-3",
        "screenshots-overlay-preview-face-label",
    ],
    "browserContext.ftl": ["main-context-menu-take-screenshot"],
    "confirmationHints.ftl": ["confirmation-hint-screenshot-copied"],
}

# Fluent variable -> Chrome positional substitution.
ARGS = {"shortcut": 1, "width": 1, "height": 2}

# Locales Chrome accepts in _locales (developer.chrome.com/docs/extensions/reference/api/i18n#locales).
CHROME_LOCALES = set(
    "ar am bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr hu "
    "id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk vi "
    "zh_CN zh_TW".split()
)
OVERRIDES = {
    "es-ES": "es", "es-MX": "es_419", "nb-NO": "no", "tl": "fil",
    "gu-IN": "gu", "hi-IN": "hi", "sv-SE": "sv",
}


def parse_ftl(text):
    """Tiny Fluent parser: messages, attributes and indented continuations."""
    messages, cur, key = {}, None, None
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z][\w-]*)\s*=\s?(.*)$", line)
        if m:
            cur = messages.setdefault(m[1], {"value": "", "attrs": {}})
            key = None
            cur["value"] = m[2]
            continue
        m = re.match(r"^\s+\.([\w-]+)\s*=\s?(.*)$", line)
        if m and cur is not None:
            key = m[1]
            cur["attrs"][key] = m[2]
            continue
        if line[0].isspace() and cur is not None:
            if key:
                cur["attrs"][key] += "\n" + line
            else:
                cur["value"] += "\n" + line
    return messages


def to_chrome(pattern):
    """Resolve a Fluent pattern to a Chrome message dict, or None if unsupported."""
    # PLATFORM() selectors: take the default (*) variant.
    def select(m):
        default = re.search(r"\*\[[^\]]+\]\s*(.*)", m[1])
        return default[1].strip() if default else ""

    text = re.sub(r"\{\s*PLATFORM\(\)\s*->(.*?)\n\s*\}", select, pattern, flags=re.S)
    text = re.sub(r'\{\s*"([^"]*)"\s*\}', r"\1", text)
    text = " ".join(part.strip() for part in text.split("\n")).strip()
    placeholders = {}

    def var(m):
        placeholders[m[1]] = {"content": f"${ARGS[m[1]]}"}
        return f"${m[1].upper()}$"

    # Escape literal "$" for Chrome first, then turn { $var } into $VAR$.
    text = re.sub(r"\{\s*\$\$(\w+)\s*\}", var, text.replace("$", "$$"))
    if "{" in text:
        return None  # message/term references we don't support
    msg = {"message": text}
    if placeholders:
        msg["placeholders"] = placeholders
    return msg


def convert(ftl_dir):
    out = {}
    for filename, ids in WANTED.items():
        path = ftl_dir / filename
        if not path.exists():
            continue
        parsed = parse_ftl(path.read_text(encoding="utf-8"))
        for mid in ids:
            if mid not in parsed:
                continue
            name = mid.replace("-", "_")
            entries = [(name, parsed[mid]["value"])] + [
                (f"{name}_{a.replace('-', '_')}", v) for a, v in parsed[mid]["attrs"].items()
            ]
            for key, pattern in entries:
                if pattern.strip():
                    msg = to_chrome(pattern)
                    if msg:
                        out[key] = msg
    return out


def write(locale, messages):
    target = ROOT / "_locales" / locale / "messages.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(messages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def main(src, l10n):
    write("en", convert(Path(src) / "browser/locales/en-US/browser"))
    written = ["en"]
    for d in sorted(Path(l10n).iterdir()):
        chrome = OVERRIDES.get(d.name, d.name.replace("-", "_"))
        if chrome in CHROME_LOCALES and not chrome.startswith("en"):
            messages = convert(d / "browser/browser")
            if messages:
                write(chrome, messages)
                written.append(chrome)
    print(f"wrote {len(written)} locales: {' '.join(written)}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
