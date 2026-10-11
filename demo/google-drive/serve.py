"""
Tiny dev server for the Google Drive demo. No Node or pnpm needed.

Serves the repository root so the demo can load Plyr straight from src/js as native ES modules.
The source uses extensionless imports (e.g. './utils/is'), so requests without an extension
are resolved to the matching .js file.

Usage: python demo/google-drive/serve.py [port]
"""

import http.server
import os
import sys
from functools import partial

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows can map .js to text/plain via the registry, which browsers reject for modules
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
    }

    def translate_path(self, path):
        resolved = super().translate_path(path)
        if not os.path.exists(resolved) and not os.path.splitext(resolved)[1]:
            for candidate in (resolved + ".js", os.path.join(resolved, "index.js")):
                if os.path.isfile(candidate):
                    return candidate
        return resolved

    def end_headers(self):
        # Always serve the latest source while editing
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=ROOT))
    except OSError as error:
        sys.exit(f"Port {PORT} is already in use ({error}). Try another: python demo/google-drive/serve.py 9000")
    print(f"Serving {ROOT}")
    print(f"Open http://localhost:{PORT}/demo/google-drive/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
