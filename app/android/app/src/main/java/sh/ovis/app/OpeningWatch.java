package sh.ovis.app;

/**
 * Times are in milliseconds on any one clock (SystemClock.elapsedRealtime
 * in the app); byte counts are the app's received total (TrafficStats), or a negative number where
 * the phone cannot count them. That total is the whole app's, not this load's alone (a check still
 * running from an earlier screen counts too), which is why bytes without an answer only put the
 * limit off, never past UNANSWERED_MAX_MS.
 */
final class OpeningWatch {
    enum Stage {
        OPENING,
        SLOW,
        STALLED,
        NO_ANSWER
    }

    static final long SLOW_AFTER_MS = 5000;

    static final long STALL_MS = 20000;

    /**
     * What must arrive before it counts as an answer without the page's own: a TLS handshake or an
     * HTTP answer is more, while a server that accepts the connection and never sends gives the app
     * only TCP's own packets, a few hundred bytes at most.
     */
    static final long FIRST_BYTES = 1024;

    static final long QUIET_MS = 5000;

    static final long UNANSWERED_MAX_MS = 60000;

    /**
     * The most the bar shows, in thousandths, until the client is up: the byte count includes TLS and
     * headers, so it can reach the files' total before the last of them has arrived, and the
     * script still has to run.
     */
    static final int MAX_PERMILLE = 950;

    private int shownPermille = -1;

    private final long startedAt;
    private final long answerLimitMs;
    private final long baseBytes;
    private long lastBytes;
    private boolean answered;
    private boolean arrived;
    private long lastProgressAt;

    OpeningWatch(long now, long answerLimitMs, long bytes) {
        this.startedAt = now;
        this.answerLimitMs = answerLimitMs;
        this.baseBytes = bytes;
        this.lastBytes = bytes;
        this.lastProgressAt = now;
    }

    void answered(long now) {
        answered = true;
        arrived = true;
        lastProgressAt = now;
    }

    void received(long now, long bytes) {
        if (bytes < 0 || baseBytes < 0 || bytes <= lastBytes) return;
        lastBytes = bytes;
        if (!arrived && bytes - baseBytes < FIRST_BYTES) return;
        arrived = true;
        lastProgressAt = now;
    }

    void keepWaiting(long now) {
        lastProgressAt = now;
    }

    long bytesSoFar() {
        return baseBytes < 0 ? 0 : lastBytes - baseBytes;
    }

    int permille(long expectedBytes) {
        if (expectedBytes <= 0 || baseBytes < 0) return -1;
        int now = (int) Math.min(MAX_PERMILLE, bytesSoFar() * 1000 / expectedBytes);
        shownPermille = Math.max(shownPermille, now);
        return shownPermille;
    }

    boolean isAnswered() {
        return answered;
    }

    boolean connectedOnly() {
        return arrived && !answered;
    }

    Stage stage(long now) {
        long elapsed = now - startedAt;
        if (!answered) {
            boolean quiet = !arrived || now - lastProgressAt >= QUIET_MS;
            if ((elapsed >= answerLimitMs && quiet) || elapsed >= UNANSWERED_MAX_MS) return Stage.NO_ANSWER;
            return arrived && elapsed >= SLOW_AFTER_MS ? Stage.SLOW : Stage.OPENING;
        }
        if (now - lastProgressAt >= STALL_MS) return Stage.STALLED;
        return now - startedAt >= SLOW_AFTER_MS ? Stage.SLOW : Stage.OPENING;
    }
}
