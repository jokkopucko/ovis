package sh.ovis.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.LongSupplier;

/**
 * The WebView's way to one SSH PC: a listener on the PC's loopback origin on this phone, each of whose
 * connections becomes an SSH channel (direct-tcpip) to the PC's own Ovis on its 127.0.0.1. That Ovis
 * sees a request from its own loopback with no proxy headers, which it lets in as its own PC's
 * (server/access.ts decideAccess, `local`): no token is typed or kept.
 *
 * <p>Every app on the phone can reach the phone's loopback, so a connection is passed on only when its
 * first request carries this tunnel's gate cookie, which the app put in the WebView's cookie store once
 * the listener was bound and no other app can read; anything else gets 403 and nothing reaches the PC.
 * The gate is taken out of the request before it goes on.
 *
 * <p>Lifetime rules (SshTunnelTest checks each, with this class's clock, dialer and closer injected):
 * <ul>
 *   <li>the SSH connection is made when a request needs it, once however many requests wait for it, and
 *       made again on the next request after it ended (the app in the background, a network change:
 *       `drop`), asking nothing; nothing waits on a dial but the requests that need it;</li>
 *   <li>a request is passed on once, as it came, with `Connection: close` (an upgrade excepted), so the
 *       WebView never re-sends it on a reused connection; one the PC side ends before answering gets
 *       503, never silence: nothing typed is sent twice (the page keeps it as a draft);</li>
 *   <li>a failure is answered at once, for RETRY_AFTER_MS, to every request of the page's burst, then
 *       tried again; looking the PC's Ovis up again happens once at a time, and its failure drops the
 *       connection into that window; a stop (SshFailure.stops: the host key, the key refused) is never
 *       tried again by this tunnel: only setting the PC up again makes another;</li>
 *   <li>`wake` (the app back in front) checks a connection that exists with a ping and makes a new one
 *       before the page asks when it no longer answers; it never signs in to a PC that had none.</li>
 * </ul>
 * A failed request gets 503 with an `X-Ovis-Ssh` header naming the failure's kind; the listener hears
 * every failure, so the app's error page can say what happened and what to do.
 */
final class SshTunnel {
    static final String GATE_COOKIE = "ovis_ssh_gate";
    static final String FAILURE_HEADER = "X-Ovis-Ssh";
    /** a failure is not retried for this long: the page's burst of requests gets the same answer at once */
    static final long RETRY_AFTER_MS = 2_000;
    private static final int HEAD_LIMIT = 64 * 1024;

    /** One SSH connection made for the tunnel, to the PC's Ovis. */
    interface Link {
        /** A new channel to the PC's Ovis. */
        Channel open() throws IOException;

        /** Looks up the PC's Ovis again (it may have restarted on another port). */
        void relocate() throws SshFailure;

        /** Whether the connection still answers, within a few seconds. */
        boolean alive();

        void close();

        /** Runs `ended` once the connection ends, whoever ends it. */
        void onEnd(Runnable ended);
    }

    interface Channel {
        InputStream input() throws IOException;

        OutputStream output() throws IOException;

        void close();
    }

    /** Connects, signs in and finds the PC's Ovis: a Link, or why not. */
    interface Dialer {
        Link dial() throws SshFailure;
    }

    interface Listener {
        void onFailure(SshFailure failure);
    }

    private final String gate;
    private final InetAddress bindHost;
    private final int bindPort;
    private final Dialer dialer;
    private final LongSupplier clock;
    private final Listener listener;
    /** where links are closed: closing one whose network died can wait on it for long */
    private final Executor closer;
    private final ExecutorService pipes = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "ovis-ssh-pipe");
        thread.setDaemon(true);
        return thread;
    });
    private final Object relocating = new Object();
    private ServerSocket server;
    private Link link;
    private CompletableFuture<Link> dialing;
    private boolean closed;
    private SshFailure lastFailure;
    private long failedAt;
    private SshFailure stopped;

    SshTunnel(String gate, InetAddress bindHost, int bindPort, Dialer dialer, LongSupplier clock, Listener listener, Executor closer) {
        this.gate = gate;
        this.bindHost = bindHost;
        this.bindPort = bindPort;
        this.dialer = dialer;
        this.clock = clock;
        this.listener = listener;
        this.closer = closer;
    }

    /** The cookie value the WebView must carry here; set it only once listen() returned. */
    String gate() {
        return gate;
    }

    /** Starts listening; the port it listens on (bindPort, or the one picked for 0). Throws when another app holds the address. */
    int listen() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(bindHost, bindPort), 64);
        Thread accept = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket client = server.accept();
                    pipes.execute(() -> serve(client));
                } catch (IOException | java.util.concurrent.RejectedExecutionException failed) {
                    // one connection that failed to arrive is not the listener's end
                    if (server.isClosed() || pipes.isShutdown()) return;
                }
            }
        }, "ovis-ssh-accept");
        accept.setDaemon(true);
        accept.start();
        return server.getLocalPort();
    }

    void close() {
        synchronized (this) {
            closed = true;
        }
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
            // closing a listener that is already gone
        }
        drop();
        pipes.shutdownNow();
    }

    /** Ends the SSH connection (a network change): the next request makes a new one. */
    void drop() {
        Link was;
        synchronized (this) {
            was = link;
            link = null;
        }
        if (was != null) closer.execute(was::close);
    }

    /** The app came back: a connection that no longer answers is dropped and made again before the page asks. */
    void wake() {
        Link now;
        synchronized (this) {
            now = link;
        }
        if (now == null || now.alive()) return;
        forget(now);
        try {
            ready();
        } catch (SshFailure failed) {
            // the page's next request is told, and the listener was
        }
    }

    private void forget(Link gone) {
        synchronized (this) {
            if (link == gone) link = null;
        }
        closer.execute(gone::close);
    }

    private Link ready() throws SshFailure {
        CompletableFuture<Link> waiting;
        boolean mine = false;
        synchronized (this) {
            if (stopped != null) {
                listener.onFailure(stopped);
                throw stopped;
            }
            if (link != null) return link;
            if (lastFailure != null && clock.getAsLong() - failedAt < RETRY_AFTER_MS) {
                listener.onFailure(lastFailure);
                throw lastFailure;
            }
            if (closed) throw new SshFailure("cancelled", "Closed");
            if (dialing == null) {
                dialing = new CompletableFuture<>();
                mine = true;
            }
            waiting = dialing;
        }
        if (!mine) return awaitDial(waiting);
        // the dial itself runs outside the lock: a drop, a close or a wake never waits on it
        Link made = null;
        SshFailure failed = null;
        try {
            made = dialer.dial();
        } catch (SshFailure refused) {
            failed = refused;
        } catch (RuntimeException unexpected) {
            failed = new SshFailure("internal", SshFailure.rootMessage(unexpected));
        }
        Link kept = made;
        synchronized (this) {
            dialing = null;
            if (failed == null && closed) failed = new SshFailure("cancelled", "Closed");
            if (failed != null) {
                remember(failed);
            } else {
                link = kept;
                lastFailure = null;
            }
        }
        if (failed != null) {
            if (made != null) closer.execute(made::close);
            waiting.completeExceptionally(failed);
            throw failed;
        }
        made.onEnd(() -> {
            synchronized (SshTunnel.this) {
                if (link == kept) link = null;
            }
        });
        waiting.complete(made);
        return made;
    }

    private Link awaitDial(CompletableFuture<Link> waiting) throws SshFailure {
        try {
            return waiting.get();
        } catch (ExecutionException failed) {
            SshFailure why = failed.getCause() instanceof SshFailure ? (SshFailure) failed.getCause() : new SshFailure("internal", SshFailure.rootMessage(failed));
            listener.onFailure(why);
            throw why;
        } catch (InterruptedException stopping) {
            Thread.currentThread().interrupt();
            throw new SshFailure("cancelled", "Cancelled");
        }
    }

    private void remember(SshFailure failed) {
        lastFailure = failed;
        failedAt = clock.getAsLong();
        if (failed.stops()) stopped = failed;
        listener.onFailure(failed);
    }

    /** A channel to the PC's Ovis; after a failed open the Ovis is looked up again, by one request at a time. */
    private Channel channel() throws SshFailure {
        Link now = ready();
        try {
            return now.open();
        } catch (IOException refused) {
            // looked up below
        }
        synchronized (relocating) {
            try {
                return now.open();
            } catch (IOException stillRefused) {
                // another request did not find it either
            }
            SshFailure failed;
            try {
                now.relocate();
                return now.open();
            } catch (SshFailure gone) {
                failed = gone;
            } catch (IOException again) {
                failed = new SshFailure("unreachable", SshFailure.rootMessage(again));
            }
            forget(now);
            synchronized (this) {
                remember(failed);
            }
            throw failed;
        }
    }

    private void serve(Socket client) {
        try {
            client.setSoTimeout(15_000);
            InputStream fromPage = client.getInputStream();
            OutputStream toPage = client.getOutputStream();
            byte[] head = readHead(fromPage);
            if (head == null || !carriesGate(head, gate)) {
                toPage.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                toPage.flush();
                client.close();
                return;
            }
            Channel stream;
            try {
                stream = channel();
            } catch (SshFailure failed) {
                answerFailure(toPage, failed);
                client.close();
                return;
            }
            client.setSoTimeout(0);
            OutputStream toPc = stream.output();
            toPc.write(forwardHead(head, gate));
            toPc.flush();
            InputStream fromPc = stream.input();
            pipes.execute(() -> pump(fromPage, toPc, client, stream));
            byte[] answer;
            try {
                answer = readHead(fromPc);
                // an interim answer (100 Continue, 103 Early Hints) goes to the page as it is, and the next head is checked too
                while (answer != null && interim(answer)) {
                    if (redirectsAway(answer, "http://" + bindHost.getHostAddress() + ":" + client.getLocalPort() + "/")) break;
                    toPage.write(answer);
                    toPage.flush();
                    answer = readHead(fromPc);
                }
            } catch (IOException dropped) {
                // the link went down before the PC answered
                answer = null;
            }
            if (answer == null) {
                // the PC side ended before answering: say so, so the page never takes silence for a reason to send again
                answerFailure(toPage, new SshFailure("unreachable", "The connection to the PC ended"));
            } else if (redirectsAway(answer, "http://" + bindHost.getHostAddress() + ":" + client.getLocalPort() + "/")) {
                toPage.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                toPage.flush();
                stream.close();
            } else {
                toPage.write(answer);
                toPage.flush();
                pump(fromPc, toPage, client, stream);
            }
            closeQuietly(client);
        } catch (IOException | RuntimeException ended) {
            closeQuietly(client);
        }
    }

    private static void answerFailure(OutputStream toPage, SshFailure failed) {
        byte[] body = (failed.kind + ": " + failed.getMessage()).getBytes(StandardCharsets.UTF_8);
        try {
            toPage.write((
                "HTTP/1.1 503 Service Unavailable\r\n" + FAILURE_HEADER + ": " + failed.kind.replaceAll("[^a-z-]", "") +
                "\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: " + body.length +
                "\r\nConnection: close\r\n\r\n"
            ).getBytes(StandardCharsets.US_ASCII));
            toPage.write(body);
            toPage.flush();
        } catch (IOException gone) {
            // the page went away first
        }
    }

    /**
     * The request head, up to its blank line, or null when the page closed first or sent more than
     * HEAD_LIMIT without one. Bytes after the blank line (a body) are left in the stream.
     */
    static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (head.size() < HEAD_LIMIT) {
            int next = in.read();
            if (next < 0) return null;
            head.write(next);
            matched = (next == '\r' && (matched == 0 || matched == 2)) || (next == '\n' && (matched == 1 || matched == 3)) ? matched + 1 : (next == '\r' ? 1 : 0);
            if (matched == 4) return head.toByteArray();
        }
        return null;
    }

    /** Whether a response head is an interim one (1xx), after which the real answer comes; 101 (an upgrade) is final. */
    static boolean interim(byte[] head) {
        String status = new String(head, 0, Math.min(head.length, 16), StandardCharsets.ISO_8859_1);
        return status.matches("HTTP/1\\.[01] 1[0-9][0-9][\\s\\S]*") && !status.startsWith("101", 9);
    }

    /**
     * Whether a response head (from the PC) redirects to an SSH PC's loopback host at another port
     * (SshPcs.otherLoopbackPort): the WebView follows a redirect without asking the app, and would send that
     * host's gate cookie to whatever listens there. `own` is this tunnel's origin, for a relative Location.
     */
    static boolean redirectsAway(byte[] head, String own) {
        for (String line : new String(head, StandardCharsets.ISO_8859_1).split("\r\n")) {
            if (!line.toLowerCase(Locale.ROOT).startsWith("location:")) continue;
            try {
                return SshPcs.otherLoopbackPort(java.net.URI.create(own).resolve(line.substring("location:".length()).trim()).toString());
            } catch (IllegalArgumentException unreadable) {
                return true;
            }
        }
        return false;
    }

    /** Whether a request head carries `gate` as the gate cookie, compared in constant time. */
    static boolean carriesGate(byte[] head, String gate) {
        if (gate == null || gate.isEmpty()) return false;
        String text = new String(head, StandardCharsets.ISO_8859_1);
        byte[] expected = gate.getBytes(StandardCharsets.US_ASCII);
        for (String line : text.split("\r\n")) {
            if (!line.toLowerCase(Locale.ROOT).startsWith("cookie:")) continue;
            for (String pair : line.substring("cookie:".length()).split(";")) {
                String[] parts = pair.trim().split("=", 2);
                if (parts.length == 2 && parts[0].equals(GATE_COOKIE) && MessageDigest.isEqual(parts[1].getBytes(StandardCharsets.US_ASCII), expected)) return true;
            }
        }
        return false;
    }

    /**
     * The head as it goes to the PC: without the gate cookie (the PC has no use for it), and with
     * `Connection: close` unless it is an upgrade (a WebSocket), so every request has a connection of its
     * own and the WebView never re-sends one on a connection that was reused.
     */
    static byte[] forwardHead(byte[] head, String gate) {
        String text = new String(head, StandardCharsets.ISO_8859_1);
        String[] lines = text.substring(0, text.length() - 4).split("\r\n", -1);
        boolean upgrade = false;
        for (String line : lines) if (line.toLowerCase(Locale.ROOT).startsWith("upgrade:")) upgrade = true;
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            String lower = line.toLowerCase(Locale.ROOT);
            if (i > 0 && lower.startsWith("cookie:")) {
                StringBuilder kept = new StringBuilder();
                for (String pair : line.substring("cookie:".length()).split(";")) {
                    if (pair.trim().startsWith(GATE_COOKIE + "=")) continue;
                    if (kept.length() > 0) kept.append(';');
                    kept.append(pair);
                }
                if (kept.toString().trim().isEmpty()) continue;
                line = "Cookie:" + kept;
            } else if (i > 0 && !upgrade && (lower.startsWith("connection:") || lower.startsWith("keep-alive:"))) {
                continue;
            }
            out.append(line).append("\r\n");
        }
        if (!upgrade) out.append("Connection: close\r\n");
        out.append("\r\n");
        return out.toString().getBytes(StandardCharsets.ISO_8859_1);
    }

    /** Copies until either side ends; the bytes copied. */
    private static long pump(InputStream from, OutputStream to, Socket client, Channel stream) {
        byte[] buffer = new byte[32 * 1024];
        long copied = 0;
        try {
            int read;
            while ((read = from.read(buffer)) >= 0) {
                to.write(buffer, 0, read);
                to.flush();
                copied += read;
            }
        } catch (IOException | RuntimeException ended) {
            // either side went away
        } finally {
            stream.close();
        }
        return copied;
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // already closed
        }
    }
}
