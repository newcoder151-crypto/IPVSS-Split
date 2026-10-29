"""Rolling timing stats for one (camera, analytic), reported every STATS_INTERVAL_SEC.

Answers the question that decides how many cameras a CPU box can carry:
"does the model keep up with the interval I asked for?"
  run  = time inside analyzer.process() (the model + post-processing)
  wait = time spent waiting for the global inference lock (other cameras/analytics running)
The very first run of an analyzer is excluded (model warm-up) and logged separately.
"""


class RollingStats:
    def __init__(self, window_sec: float, t0: float):
        self.window_sec = window_sec
        self.start = t0
        self.n = 0
        self.sum_run = 0.0
        self.max_run = 0.0
        self.sum_wait = 0.0

    def add(self, wait: float, run: float) -> None:
        self.n += 1
        self.sum_run += run
        self.sum_wait += wait
        self.max_run = max(self.max_run, run)

    def due(self, t: float) -> bool:
        return t - self.start >= self.window_sec

    def reset(self, t: float) -> None:
        self.start, self.n = t, 0
        self.sum_run = self.max_run = self.sum_wait = 0.0

    def report(self, t: float, interval_sec: float):
        """Returns (message, is_slow). Caller logs it and then calls reset()."""
        elapsed = max(1e-6, t - self.start)
        if self.n == 0:
            return ("no analysis runs in the last %.0fs (stream stalled?)" % elapsed, False)
        run = self.sum_run / self.n
        wait = self.sum_wait / self.n
        rate = self.n / elapsed
        want = 1.0 / interval_sec
        msg = ("%d runs in %.0fs (%.2f/s, wanted %.2f/s) | run avg %.0f ms, max %.0f ms | lock wait avg %.0f ms"
               % (self.n, elapsed, rate, want, run * 1000, self.max_run * 1000, wait * 1000))
        cycle = run + wait
        if cycle > interval_sec:
            if run > interval_sec:
                hint = "model is slower than interval_sec: raise interval_sec or use a smaller model"
            else:
                hint = "waiting on other analyzers (CPU is shared): fewer cameras, a longer interval_sec, or a smaller model"
            return (msg + " | SLOW: " + hint, True)
        return (msg + " | keeping up", False)
