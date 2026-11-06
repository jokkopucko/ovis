package sh.ovis.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Test;

public class DirectSocketTest {
    /** What the client told its listener, in order. */
    private final BlockingQueue<String> events = new LinkedBlockingQueue<>();
    private ServerSocket server;

    private final DirectSocket.Listener listener = new DirectSocket.Listener() {
        @Override public void onText(String text) { events.add("text:" + text); }
        @Override public void onBinary(byte[] bytes) { events.add("binary:" + bytes.length); }
        @Override public void onClose(int code, String reason, boolean failed) { events.add("close:" + code + ":" + failed); }
    };

    @After
    public void stop() throws IOException {
        if (server != null) server.close();
    }

    /** A peer on loopback that runs `peer` on the first connection. */
    private interface Peer { void run(Socket socket) throws Exception; }

    private DirectSocket client(Peer peer, int handshakeMs) throws IOException {
        server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        Thread thread = new Thread(() -> {
            try (Socket socket = server.accept()) { peer.run(socket); } catch (Exception ignored) { /* the test reads the client's side */ }
        });
        thread.setDaemon(true);
        thread.start();
        return new DirectSocket("127.0.0.1", server.getLocalPort(), listener, handshakeMs);
    }

    /** Reads the request and answers it with `status` and `headers`, the accept key added when `accept`. */
    private static void upgrade(Socket socket, String status, String headers, boolean accept) throws Exception {
        InputStream in = socket.getInputStream();
        String key = null;
        StringBuilder line = new StringBuilder();
        for (int read; (read = in.read()) != -1; ) {
            if (read != '\n') { if (read != '\r') line.append((char) read); continue; }
            if (line.length() == 0) break;
            if (line.toString().startsWith("Sec-WebSocket-Key: ")) key = line.substring(19);
            line.setLength(0);
        }
        String acceptKey = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
            .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
        String answer = status + "\r\n" + headers + (accept ? "Sec-WebSocket-Accept: " + acceptKey + "\r\n" : "") + "\r\n";
        socket.getOutputStream().write(answer.getBytes(StandardCharsets.US_ASCII));
    }

    private static final String GOOD = "Upgrade: websocket\r\nConnection: Upgrade\r\n";

    /** A frame as a server sends it: unmasked, a short payload. */
    private static byte[] frame(int first, byte[] payload) {
        byte[] out = new byte[2 + payload.length];
        out[0] = (byte) first;
        out[1] = (byte) payload.length;
        System.arraycopy(payload, 0, out, 2, payload.length);
        return out;
    }

    private String next() throws InterruptedException {
        String event = events.poll(10, TimeUnit.SECONDS);
        assertNotNull("no event within 10 s", event);
        return event;
    }

    @Test
    public void opensOnlyAPrivateCarriersChannelAddress() {
        assertArrayEquals(new String[] { "192.168.0.10", "7319" }, DirectSocket.carrier("ws://192.168.0.10:7319/v1/ws?v=1"));
        assertArrayEquals(new String[] { "10.1.2.3", "40000" }, DirectSocket.carrier("ws://10.1.2.3:40000/v1/ws?v=1"));
        assertArrayEquals(new String[] { "172.31.0.1", "7319" }, DirectSocket.carrier("ws://172.31.0.1:7319/v1/ws?v=1"));
        assertArrayEquals(new String[] { "169.254.9.9", "7319" }, DirectSocket.carrier("ws://169.254.9.9:7319/v1/ws?v=1"));
        String[] refused = {
            null,
            "ws://8.8.8.8:7319/v1/ws?v=1",
            "ws://172.32.0.1:7319/v1/ws?v=1",
            "ws://127.0.0.1:7319/v1/ws?v=1",
            "ws://192.168.0.256:7319/v1/ws?v=1",
            "ws://192.168.00.1:7319/v1/ws?v=1",
            "ws://192.168.0.10:70000/v1/ws?v=1",
            "wss://192.168.0.10:7319/v1/ws?v=1",
            "ws://192.168.0.10/v1/ws?v=1",
            "ws://192.168.0.10:7319/v1/ws",
            "ws://192.168.0.10:7319/v1/ws?v=1&x=1",
            "ws://pc.local:7319/v1/ws?v=1",
        };
        for (String url : refused) assertNull(url, DirectSocket.carrier(url));
    }

    @Test
    public void givesUpOnAPeerThatNeverAnswersTheUpgrade() throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        DirectSocket socket = client((peer) -> held.await(), 300);
        socket.start();
        assertEquals("close:1006:true", next());
        held.countDown();
    }

    @Test
    public void closeEndsAPendingHandshakeAtOnce() throws Exception {
        CountDownLatch connected = new CountDownLatch(1);
        CountDownLatch held = new CountDownLatch(1);
        DirectSocket socket = client((peer) -> { connected.countDown(); held.await(); }, 60_000);
        socket.start();
        assertTrue(connected.await(10, TimeUnit.SECONDS));
        socket.close(4000, "probe done");
        assertEquals("close:4000:false", next());
        held.countDown();
    }

    @Test
    public void refusesWhatIsNotAWebSocketUpgrade() throws Exception {
        String[][] answers = {
            { "HTTP/1.1 1010 Nope", GOOD },
            { "HTTP/1.1 200 OK", GOOD },
            { "HTTP/1.1 101 Switching Protocols", "Connection: Upgrade\r\n" },
            { "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket\r\nConnection: keep-alive\r\n" },
        };
        for (String[] answer : answers) {
            DirectSocket socket = client((peer) -> upgrade(peer, answer[0], answer[1], true), 5_000);
            socket.start();
            assertEquals(answer[0] + answer[1], "close:1006:true", next());
            server.close();
        }
    }

    @Test
    public void takesMixedCaseHeadersAndATokenList() throws Exception {
        DirectSocket socket = client((peer) -> {
            upgrade(peer, "HTTP/1.1 101 Switching Protocols", "upgrade: WebSocket\r\nconnection: keep-alive, Upgrade\r\n", true);
            peer.getOutputStream().write(frame(0x81, "hi".getBytes(StandardCharsets.UTF_8)));
            new DataInputStream(peer.getInputStream()).readFully(new byte[1]);
        }, 5_000);
        socket.start();
        assertEquals("text:hi", next());
        socket.close(1000, "");
    }

    @Test
    public void endsOnFramesTheProtocolForbids() throws Exception {
        byte[][] frames = {
            frame(0x81 | 0x40, "x".getBytes(StandardCharsets.UTF_8)),
            frame(0x09, new byte[0]),
            frame(0x88, new byte[] { 3 }),
            frame(0x88, new byte[] { 0x03, (byte) 0xEC }),
            frame(0x81, new byte[] { (byte) 0xC3, 0x28 }),
        };
        String[] expected = { "close:1002:true", "close:1002:true", "close:1002:true", "close:1002:true", "close:1007:true" };
        for (int index = 0; index < frames.length; index++) {
            byte[] bad = frames[index];
            DirectSocket socket = client((peer) -> {
                upgrade(peer, "HTTP/1.1 101 Switching Protocols", GOOD, true);
                peer.getOutputStream().write(bad);
                peer.getInputStream().read(new byte[64]);
            }, 5_000);
            socket.start();
            assertEquals("frame " + index, expected[index], next());
            server.close();
        }
    }

    @Test
    public void answersThePeersCloseBeforeItLetsGo() throws Exception {
        BlockingQueue<Integer> answered = new LinkedBlockingQueue<>();
        DirectSocket socket = client((peer) -> {
            upgrade(peer, "HTTP/1.1 101 Switching Protocols", GOOD, true);
            peer.getOutputStream().write(frame(0x88, new byte[] { 0x03, (byte) 0xE9, 'b', 'y', 'e' }));
            DataInputStream in = new DataInputStream(peer.getInputStream());
            int first = in.readUnsignedByte();
            in.readUnsignedByte();
            byte[] mask = new byte[4];
            in.readFully(mask);
            byte[] code = new byte[2];
            in.readFully(code);
            answered.add(first == 0x88 ? (((code[0] ^ mask[0]) & 0xff) << 8) | ((code[1] ^ mask[1]) & 0xff) : -1);
        }, 5_000);
        socket.start();
        assertEquals("close:1001:false", next());
        assertEquals(Integer.valueOf(1001), answered.poll(10, TimeUnit.SECONDS));
    }

    /** The close frame the client sent after the upgrade, unmasked: [code, reason bytes...]. */
    private DirectSocket closingClient(BlockingQueue<byte[]> closes) throws IOException {
        return client((peer) -> {
            upgrade(peer, "HTTP/1.1 101 Switching Protocols", GOOD, true);
            peer.getOutputStream().write(frame(0x81, "hi".getBytes(StandardCharsets.UTF_8)));
            DataInputStream in = new DataInputStream(peer.getInputStream());
            int first = in.readUnsignedByte();
            int length = in.readUnsignedByte() & 0x7f;
            byte[] mask = new byte[4];
            in.readFully(mask);
            byte[] payload = new byte[length];
            in.readFully(payload);
            for (int index = 0; index < length; index++) payload[index] ^= mask[index & 3];
            if (first == 0x88) closes.add(payload);
        }, 5_000);
    }

    @Test
    public void cutsALongCloseReasonBetweenCharacters() throws Exception {
        BlockingQueue<byte[]> closes = new LinkedBlockingQueue<>();
        DirectSocket socket = closingClient(closes);
        socket.start();
        assertEquals("text:hi", next());
        String ascii = "a".repeat(122);
        socket.close(4000, ascii + "\u00e9");
        byte[] payload = closes.poll(10, TimeUnit.SECONDS);
        assertNotNull(payload);
        assertEquals(ascii, StandardCharsets.UTF_8.newDecoder()
            .decode(java.nio.ByteBuffer.wrap(payload, 2, payload.length - 2)).toString());
    }

    @Test
    public void neverSendsACloseCodeReservedForTheEndpoint() throws Exception {
        BlockingQueue<byte[]> closes = new LinkedBlockingQueue<>();
        DirectSocket socket = closingClient(closes);
        socket.start();
        assertEquals("text:hi", next());
        socket.close(1006, "");
        byte[] payload = closes.poll(10, TimeUnit.SECONDS);
        assertNotNull(payload);
        assertEquals(1000, ((payload[0] & 0xff) << 8) | (payload[1] & 0xff));
    }

    @Test
    public void endsWithA1009WhenTooMuchWaitsToGoOut() throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        // nothing goes out before the upgrade, which this peer holds back
        DirectSocket socket = client((peer) -> held.await(), 60_000);
        socket.start();
        byte[] mebibyte = new byte[1024 * 1024];
        for (int count = 0; count < 4; count++) socket.sendBinary(mebibyte);
        assertTrue(events.isEmpty());
        socket.sendBinary(new byte[1]);
        assertEquals("close:1009:false", next());
        held.countDown();
    }

    @Test
    public void countsFramesAsWellAsBytes() throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        DirectSocket socket = client((peer) -> held.await(), 60_000);
        socket.start();
        for (int count = 0; count < DirectSocket.MAX_QUEUED; count++) socket.sendText("");
        assertFalse(events.contains("close:1009:false"));
        socket.sendText("");
        assertEquals("close:1009:false", next());
        held.countDown();
    }
}
