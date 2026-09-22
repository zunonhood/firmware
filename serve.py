from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HOST = "127.0.0.1"
PORT = 4173

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

if __name__ == "__main__":
    print(f"SILICON online at http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), NoCacheHandler).serve_forever()
