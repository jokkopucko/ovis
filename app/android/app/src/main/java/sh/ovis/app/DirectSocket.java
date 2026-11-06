package sh.ovis.app;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A plain `ws://` WebSocket client (RFC 6455) for one direct carrier (OvisDirectPlugin): the app has no
 * WebSocket library, and a carrier is never TLS (Noise inside the relay channel proves the PC). No
 * Android types, so it runs in JVM tests. Messages arrive in order on its reader thread; sends go out in
 * order on its writer thread. Bounded both ways: a message over MAX_MESSAGE, or more than MAX_MESSAGE
 * bytes or MAX_QUEUED frames waiting to go out (pongs included), ends the socket with 1009; a peer that
 * does not finish the upgrade within the handshake time ends it too.
 */
final class DirectSocket {
    static final int MAX_MESSAGE = 4 * 1024 * 1024;
    static final int MAX_QUEUED = 16_384;
    static final int HANDSHAKE_MS = 5_000;
    private static final int CONNECT_MS = 10_000;
    /** how long a close waits for the peer's answer before the socket is let go */
    private static final int CLOSE_WAIT_MS = 5_000;
    private static final Pattern CARRIER = Pattern.compile("^ws://((?:0|[1-9]\\d{0,2})(?:\\.(?:0|[1-9]\\d{0,2})){3}):([1-9]\\d{0,4})/v1/ws\\?v=1$");
    private static final Pattern UPGRADED = Pattern.compile("^HTTP/1\\.1 101(?: .*)?$");
    private static final ScheduledExecutorService TIMERS = Executors.newSingleThreadScheduledExecutor((task) -> {
        Thread thread = new Thread(task, "ovis-direct-timer");
        thread.setDaemon(true);
        return thread;
    });

    interface Listener {
        void onText(String text);
        void onBinary(byte[] bytes);
        /** Once, last: `failed` when it broke rather than closed. */
        void onClose(int code, String reason, boolean failed);
    }

    /** host and port of `url` when it is exactly a direct carrier's channel address on a private IPv4 address, else null */
    static String[] carrier(String url) {
        if (url == null) return null;
        Matcher match = CARRIER.matcher(url);
        if (!match.matches()) return null;
        String[] octets = match.group(1).split("\\.");
        int a = Integer.parseInt(octets[0]);
        int b = Integer.parseInt(octets[1]);
        for (String octet : octets) if (Integer.parseInt(octet) > 255) return null;
        if (Integer.parseInt(match.group(2)) > 65535) return null;
        boolean privateAddress = a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
        return privateAddress ? new String[] { match.group(1), match.group(2) } : null;
    }

    /** Whether a peer may close with `code` (RFC 6455 7.4): the defined ones it may send, and 3000-4999. */
    static boolean validCloseCode(int code) {
        return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
    }

    private final String host;
    private final int port;
    private final Listener listener;
    private final int handshakeMs;
    private final Socket socket = new Socket();
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final SecureRandom random = new SecureRandom();
    /** counted down once the handshake is done or the socket ended: no frame goes out before */
    private final CountDownLatch upgradedLatch = new CountDownLatch(1);
    private boolean upgraded;
    private boolean ended;
    private boolean closeQueued;
    private long queuedBytes;
    private int queuedFrames;

    DirectSocket(String host, int port, Listener listener) {
        this(host, port, listener, HANDSHAKE_MS);
    }

    DirectSocket(String host, int port, Listener listener, int handshakeMs) {
        this.host = host;
        this.port = port;
        this.listener = listener;
        this.handshakeMs = handshakeMs;
    }

    void start() {
        writer.execute(() -> {
            try { upgradedLatch.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        });
        Thread reader = new Thread(this::run, "ovis-direct");
        reader.setDaemon(true);
        reader.start();
    }

    void sendText(String text) {
        enqueue(0x1, text.getBytes(StandardCharsets.UTF_8), false);
    }

    void sendBinary(byte[] bytes) {
        enqueue(0x2, bytes, false);
    }

    /**
     * Ends the socket with `code`: before the upgrade at once, closing the TCP socket under a pending connect or
     * handshake; after it with a close frame, then onClose when the peer answers or CLOSE_WAIT_MS passed. A code
     * an endpoint may not send (1005, 1006, 1015, an unassigned one) goes out as 1000.
     */
    void close(int code, String reason) {
        if (!validCloseCode(code)) code = 1000;
        boolean beforeUpgrade;
        synchronized (this) {
            if (ended || closeQueued) return;
            beforeUpgrade = !upgraded;
            if (beforeUpgrade) closeQueued = true;
        }
        int sent = code;
        if (beforeUpgrade) {
            end(sent, reason, false);
            return;
        }
        sendClose(sent, reason);
        TIMERS.schedule(() -> end(sent, reason, false), CLOSE_WAIT_MS, TimeUnit.MILLISECONDS);
    }

    /** Ends the socket now, without a closing handshake: the page fell too far behind. */
    void abort(int code, String reason) {
        end(code, reason, false);
    }

    /** A close frame, once; data frames asked for after it are dropped. Its reason is cut to 123 bytes between characters. */
    private void sendClose(int code, String reason) {
        byte[] text = reason.getBytes(StandardCharsets.UTF_8);
        int length = Math.min(text.length, 123);
        // never inside a character: back off continuation bytes (10xxxxxx) to the start of the one cut
        if (length < text.length) while (length > 0 && (text[length] & 0xc0) == 0x80) length--;
        byte[] payload = new byte[2 + length];
        payload[0] = (byte) (code >> 8);
        payload[1] = (byte) code;
        System.arraycopy(text, 0, payload, 2, payload.length - 2);
        synchronized (this) {
            if (ended || closeQueued) return;
            closeQueued = true;
        }
        enqueue(0x8, payload, true);
    }

    /**
     * Puts one frame on the writer's queue, or ends the socket with 1009 when the queue is full. Admitted and handed to
     * the writer under one lock, so a data frame admitted before the close frame is also queued before it.
     */
    private void enqueue(int opcode, byte[] payload, boolean control) {
        synchronized (this) {
            if (ended || (closeQueued && !control)) return;
            if (queuedFrames + 1 <= MAX_QUEUED && queuedBytes + payload.length <= MAX_MESSAGE) {
                queuedFrames++;
                queuedBytes += payload.length;
                try {
                    writer.execute(() -> {
                        try {
                            frame(opcode, payload);
                        } catch (IOException error) {
                            end(1006, "", true);
                        } finally {
                            synchronized (this) {
                                queuedFrames--;
                                queuedBytes -= payload.length;
                            }
                        }
                    });
                } catch (java.util.concurrent.RejectedExecutionException gone) {
                    // ended meanwhile: nothing goes out any more
                }
                return;
            }
        }
        end(1009, "send queue full", false);
    }

    /** One masked frame, as a client must send. Only the writer thread calls it. */
    private void frame(int opcode, byte[] payload) throws IOException {
        synchronized (this) { if (ended) return; }
        ByteArrayOutputStream out = new ByteArrayOutputStream(payload.length + 14);
        out.write(0x80 | opcode);
        if (payload.length < 126) {
            out.write(0x80 | payload.length);
        } else if (payload.length < 65536) {
            out.write(0x80 | 126);
            out.write(payload.length >> 8);
            out.write(payload.length);
        } else {
            out.write(0x80 | 127);
            for (int shift = 56; shift >= 0; shift -= 8) out.write((int) ((long) payload.length >> shift));
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        out.write(mask);
        for (int index = 0; index < payload.length; index++) out.write(payload[index] ^ mask[index & 3]);
        OutputStream stream = socket.getOutputStream();
        stream.write(out.toByteArray());
        stream.flush();
    }

    private void run() {
        try {
            socket.connect(new InetSocketAddress(host, port), CONNECT_MS);
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(handshakeMs);
            DataInputStream in = new DataInputStream(socket.getInputStream());
            handshake(in);
            socket.setSoTimeout(0);
            synchronized (this) {
                if (ended) return;
                upgraded = true;
            }
            upgradedLatch.countDown();
            read(in);
        } catch (ProtocolError error) {
            failProtocol(error.code, error.getMessage());
        } catch (IOException error) {
            end(1006, "", true);
        }
    }

    private static final class ProtocolError extends IOException {
        private static final long serialVersionUID = 1L;
        final int code;

        ProtocolError(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    private void handshake(DataInputStream in) throws IOException {
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        String key = Base64.getEncoder().encodeToString(nonce);
        String request = "GET /v1/ws?v=1 HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
        OutputStream out = socket.getOutputStream();
        out.write(request.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String status = line(in);
        if (!UPGRADED.matcher(status).matches()) throw new IOException("not upgraded: " + status);
        String expected;
        try {
            expected = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IOException(error);
        }
        boolean accepted = false;
        boolean websocket = false;
        boolean connectionUpgrade = false;
        int headers = 0;
        for (String header = line(in); !header.isEmpty(); header = line(in)) {
            if (++headers > 64) throw new IOException("too many headers");
            int colon = header.indexOf(':');
            if (colon <= 0) continue;
            String name = header.substring(0, colon).trim();
            String value = header.substring(colon + 1).trim();
            if (name.equalsIgnoreCase("Sec-WebSocket-Accept")) accepted = value.equals(expected);
            else if (name.equalsIgnoreCase("Upgrade")) websocket = value.equalsIgnoreCase("websocket");
            else if (name.equalsIgnoreCase("Connection")) {
                for (String token : value.split(",")) if (token.trim().equalsIgnoreCase("upgrade")) connectionUpgrade = true;
            }
        }
        if (!accepted || !websocket || !connectionUpgrade) throw new IOException("not a WebSocket upgrade");
    }

    /** One header line, at most 8 KiB. */
    private static String line(InputStream in) throws IOException {
        StringBuilder text = new StringBuilder();
        for (int byteRead; (byteRead = in.read()) != -1; ) {
            if (byteRead == '\n') return text.toString().replaceAll("\r$", "");
            if (text.length() > 8192) throw new IOException("header too long");
            text.append((char) byteRead);
        }
        throw new IOException("closed during the handshake");
    }

    private static String utf8(byte[] bytes, int offset, int length) throws ProtocolError {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, offset, length)).toString();
        } catch (CharacterCodingException error) {
            throw new ProtocolError(1007, "invalid UTF-8");
        }
    }

    private void read(DataInputStream in) throws IOException {
        ByteArrayOutputStream message = null;
        int messageType = 0;
        while (true) {
            int first = in.readUnsignedByte();
            int second = in.readUnsignedByte();
            boolean fin = (first & 0x80) != 0;
            int opcode = first & 0x0f;
            boolean control = opcode >= 0x8;
            if ((first & 0x70) != 0) throw new ProtocolError(1002, "reserved bits set");
            if ((second & 0x80) != 0) throw new ProtocolError(1002, "a server frame is never masked");
            long length = second & 0x7f;
            if (length == 126) {
                length = in.readUnsignedShort();
                if (length < 126) throw new ProtocolError(1002, "length not minimal");
            } else if (length == 127) {
                length = in.readLong();
                if (length >= 0 && length < 65536) throw new ProtocolError(1002, "length not minimal");
            }
            if (control && (!fin || length > 125)) throw new ProtocolError(1002, "invalid control frame");
            if (length < 0 || length > MAX_MESSAGE) {
                failProtocol(1009, "message too big");
                return;
            }
            byte[] payload = new byte[(int) length];
            in.readFully(payload);
            switch (opcode) {
                case 0x8: {
                    if (payload.length == 1) throw new ProtocolError(1002, "invalid close payload");
                    int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
                    if (payload.length >= 2 && !validCloseCode(code)) throw new ProtocolError(1002, "invalid close code");
                    String reason = payload.length > 2 ? utf8(payload, 2, payload.length - 2) : "";
                    peerClosed(code, reason);
                    return;
                }
                case 0x9:
                    enqueue(0xA, payload, true);
                    continue;
                case 0xA:
                    continue;
                case 0x1:
                case 0x2:
                    if (message != null) throw new ProtocolError(1002, "a new message inside a fragmented one");
                    message = new ByteArrayOutputStream();
                    messageType = opcode;
                    break;
                case 0x0:
                    if (message == null) throw new ProtocolError(1002, "a continuation without a message");
                    break;
                default:
                    throw new ProtocolError(1002, "unknown opcode " + opcode);
            }
            if (message.size() + payload.length > MAX_MESSAGE) {
                failProtocol(1009, "message too big");
                return;
            }
            message.write(payload);
            if (!fin) continue;
            byte[] whole = message.toByteArray();
            message = null;
            String text = messageType == 0x1 ? utf8(whole, 0, whole.length) : null;
            synchronized (this) { if (ended) return; }
            if (text != null) listener.onText(text);
            else listener.onBinary(whole);
        }
    }

    /** The peer closed: its close is answered (unless ours went first), and the socket ends once that is written. */
    private void peerClosed(int code, String reason) {
        sendClose(code == 1005 ? 1000 : code, "");
        afterWrites(() -> end(code, reason, false));
    }

    /** The peer broke the protocol: a close with `code`, written before the socket ends. */
    private void failProtocol(int code, String reason) {
        sendClose(code, reason);
        afterWrites(() -> end(code, reason, code != 1009));
    }

    /** Runs `then` once the frames queued before it are written, or after CLOSE_WAIT_MS should the writer be stuck. */
    private void afterWrites(Runnable then) {
        TIMERS.schedule(then, CLOSE_WAIT_MS, TimeUnit.MILLISECONDS);
        try { writer.execute(then); } catch (java.util.concurrent.RejectedExecutionException gone) { then.run(); }
    }

    private void end(int code, String reason, boolean failed) {
        synchronized (this) {
            if (ended) return;
            ended = true;
        }
        upgradedLatch.countDown();
        try { socket.close(); } catch (IOException ignored) { /* already gone */ }
        writer.shutdownNow();
        listener.onClose(code, reason, failed);
    }
}
