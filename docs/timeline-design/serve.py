"""Serves the repository on http://127.0.0.1:4330 without caching, for the timeline mockups."""
import functools
import http.server
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


http.server.ThreadingHTTPServer(('127.0.0.1', 4330), functools.partial(NoCache, directory=str(ROOT))).serve_forever()
