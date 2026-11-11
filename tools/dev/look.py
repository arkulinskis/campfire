"""Look at the fire engine without Anvil: serve tools/dev/harness.html and drive it with headless Chrome.

    python -I tools/dev/look.py shots OUT [--place forest,snow,desert] [--q high] [--warp 45] [--gpu] [--phone]
        three frames of each place, about a second apart, as PNGs in OUT (read them)
    python -I tools/dev/look.py run STEPS.json OUT [--query "place=snow&q=low"] [--gpu] [--phone] [--old DIR]
        any drive.mjs steps ({eval}, {wait}, {waitFor}, {shot}) against the harness; the log is printed
    python -I tools/dev/look.py js FILE.js OUT [--query ...] [--gpu]
        run one JavaScript file in the harness (its last expression / returned promise is printed as [eval] ...)

--gpu      draw on this PC's graphics card (real frame rates) instead of the CPU rasteriser SwiftShader
--uncap    with --gpu: no frame-rate limit, to measure how fast a frame really is
--phone    a 390 x 844 phone screen (touch, device pixel ratio 2)
--size W,H an exact picture size in CSS pixels (screenshots come out twice that: pixel ratio 2)
--old DIR  also serve DIR at /old/ (an earlier copy of theme/assets); use --query "a=OLD" to run that copy
--window W,H  desktop window size (default 1280,800)
In a page: window.F is the engine (F.warp(sec), F.state(), F.setPlace(..)), HARNESS_ERRORS lists script errors.
"""
import functools
import http.server
import json
import os
import pathlib
import socket
import subprocess
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DRIVE = ROOT / "tools" / "live" / "drive.mjs"


def opt(args, name, default=None):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i:i + 2]
        return v
    return default


def flag(args, name):
    if name in args:
        args.remove(name)
        return True
    return False


class Handler(http.server.SimpleHTTPRequestHandler):
    old = None

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if self.old and clean.startswith("/old/"):
            return str(pathlib.Path(self.old) / clean[len("/old/"):])
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


def serve(old):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    Handler.old = old
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


def drive(port, query, steps, out, gpu, uncap, phone, window, timeout=1500, size=None):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    f = out / "steps.json"
    f.write_text(json.dumps(steps), encoding="utf-8")
    env = dict(os.environ, WINDOW=window)
    if gpu:
        env["ANGLE"] = "d3d11"
    if uncap:
        env["UNCAP"] = "1"
    if phone or size:
        env["MOBILE"] = size or "390,844"
    url = "http://127.0.0.1:%d/tools/dev/harness.html?%s" % (port, query)
    r = subprocess.run(["node", str(DRIVE), url, str(f), str(out)], capture_output=True, text=True, encoding="utf-8",
                       errors="replace", env=env, timeout=timeout)
    return r.stdout + r.stderr


READY = {"waitFor": "window.HARNESS_READY === true", "timeout": 90000}
ERRS = {"eval": "JSON.stringify({errors: window.HARNESS_ERRORS, ok: !!(window.F && window.F.ok), reason: window.F && window.F.reason})"}


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("shots", "run", "js"):
        sys.exit(__doc__)
    cmd = args.pop(0)
    gpu, uncap, phone = flag(args, "--gpu"), flag(args, "--uncap"), flag(args, "--phone")
    old, window, size = opt(args, "--old"), opt(args, "--window", "1280,800"), opt(args, "--size")
    query = opt(args, "--query", "")
    srv, port = serve(old)
    try:
        if cmd == "shots":
            places = opt(args, "--place", "forest,snow,desert").split(",")
            q, warp = opt(args, "--q", "high"), float(opt(args, "--warp", "45"))
            out = pathlib.Path(args[0])
            settle = 2500 if gpu else 9000
            for place in places:
                steps = [READY, ERRS, {"eval": "JSON.stringify(F.warp(%s))" % warp}, {"wait": settle}]
                for k in range(3):
                    steps += [{"shot": "%s_%s_%d" % (place, q, k)}, {"wait": 700 if gpu else 2500}]
                steps.append({"eval": "JSON.stringify(F.state())"})
                extra = ("&" + query) if query else ""
                print(drive(port, "place=%s&q=%s%s" % (place, q, extra), steps, out, gpu, uncap, phone, window, size=size))
        elif cmd == "run":
            steps = [READY, ERRS] + json.loads(pathlib.Path(args[0]).read_text(encoding="utf-8"))
            print(drive(port, query, steps, args[1], gpu, uncap, phone, window, size=size))
        else:
            code = pathlib.Path(args[0]).read_text(encoding="utf-8")
            print(drive(port, query, [READY, ERRS, {"eval": code}], args[1], gpu, uncap, phone, window, size=size))
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
