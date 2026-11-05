package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.Timeout;

public class PCStoreTest {
    private static final String OVIS = "{\"ok\":true,\"auth\":{\"required\":true,\"authenticated\":false},\"bridge_protocol\":1}";

    /** A probe that never gives up hangs here instead of passing. */
    @Rule
    public final Timeout timeout = Timeout.seconds(20);

    private final List<ServerSocket> servers = new ArrayList<>();

    private final List<String> requestLines = Collections.synchronizedList(new ArrayList<>());

    /** A server on 127.0.0.1 answering every request with `status`, `location` and `body`. */
    private String serve(int status, String location, String body) throws IOException {
        return serve(status, location, body.getBytes(StandardCharsets.UTF_8));
    }

    private String serve(int status, String location, byte[] bytes) throws IOException {
        String head = "HTTP/1.1 " + status + " Test\r\n" + (location == null ? "" : "Location: " + location + "\r\n")
            + "Content-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
        return listen(out -> {
            out.write(head.getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
        });
    }

    /** A server that answers 200 and then sends its headers, or its body, one byte at a time, never finishing. */
    private String serveSlowly(boolean headers) throws IOException {
        return listen(out -> {
            String head = headers ? "HTTP/1.1 200 Test\r\nX-Slow: " : "HTTP/1.1 200 Test\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n";
            out.write(head.getBytes(StandardCharsets.UTF_8));
            try {
                while (true) {
                    out.write(headers ? 'a' : ' ');
                    out.flush();
                    Thread.sleep(50);
                }
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
            }
        });
    }

    private interface Answer {
        void write(OutputStream out) throws IOException;
    }

    private String listen(Answer answer) throws IOException {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        servers.add(server);
        Thread thread = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    BufferedReader request = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    requestLines.add(request.readLine());
                    for (String line = request.readLine(); line != null && !line.isEmpty(); line = request.readLine()) { }
                    OutputStream out = socket.getOutputStream();
                    answer.write(out);
                    out.flush();
                } catch (IOException closed) {
                    if (server.isClosed()) return;
                }
            }
        });
        thread.setDaemon(true);
        thread.start();
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    /** An address whose /api/health redirects `redirects` times in a row before it reaches `end`. */
    private String redirecting(int redirects, String end) throws IOException {
        String next = end;
        for (int i = 0; i < redirects; i++) next = serve(302, next + "/api/health?scope=bridge", "");
        return next;
    }

    private static String probe(String target) {
        return PCStore.ovisOrigin(target, PCStore.PROBE_BUDGET_MS, new ArrayList<>());
    }

    @After
    public void stop() throws IOException {
        for (ServerSocket server : servers) server.close();
    }

    @Test
    public void anOriginThatAnswersAsOvisIsOvis() throws IOException {
        String ovis = serve(200, null, OVIS);
        assertEquals(ovis, probe(ovis + "/?pair=123456"));
        assertEquals(Collections.singletonList("GET /api/health?scope=bridge HTTP/1.1"), requestLines);
    }

    @Test
    public void followsRedirectsOfItsQuestionToTheOvisServer() throws IOException {
        String ovis = serve(200, null, OVIS);
        String upgrade = serve(301, ovis + "/api/health?scope=bridge", "");
        List<String> path = new ArrayList<>();
        assertEquals(ovis, PCStore.ovisOrigin(upgrade + "/", PCStore.PROBE_BUDGET_MS, path));
        assertEquals(java.util.Arrays.asList(upgrade, ovis), path);
    }

    @Test
    public void followsAtMostFiveRedirects() throws IOException {
        String ovis = serve(200, null, OVIS);
        assertEquals(ovis, probe(redirecting(PCStore.MAX_REDIRECTS, ovis) + "/"));
        assertNull(probe(redirecting(PCStore.MAX_REDIRECTS + 1, ovis) + "/"));
    }

    @Test
    public void aSignInPageOrAnotherSiteIsNotOvis() throws IOException {
        assertNull(probe(serve(200, null, "<!doctype html><title>Sign in</title>") + "/login"));
        assertNull(probe(serve(200, null, "{\"ok\":true}") + "/"));
        assertNull(probe(serve(200, null, "{\"ok\":true,\"auth\":{}}") + "/"));
        assertNull(probe(serve(200, null, "{\"ok\":\"true\",\"auth\":{},\"bridge_protocol\":1}") + "/"));
        assertNull(probe(serve(401, null, OVIS) + "/"));
        String signIn = serve(200, null, "<!doctype html><title>Sign in</title>");
        assertNull(probe(serve(302, signIn + "/login?next=/", "") + "/"));
    }

    @Test
    public void onlyABridgeProtocolThisAppKnowsIsOvis() throws IOException {
        for (String version : new String[] {"-1", "0", "0.5", "1.0", "1e0", "2", "\"1\"", "true", "null", "99999999999999999999"}) {
            assertNull(version, probe(serve(200, null, "{\"ok\":true,\"auth\":{},\"bridge_protocol\":" + version + "}") + "/"));
        }
    }

    @Test
    public void anAnswerThatIsNotStrictJsonIsNotOvis() throws IOException {
        assertNull(probe(serve(200, null, "{ok:true,auth:{},bridge_protocol:1}") + "/"));
        assertNull(probe(serve(200, null, OVIS + "trailing non-JSON") + "/"));
        assertNull(probe(serve(200, null, OVIS + OVIS) + "/"));
        assertNull(probe(serve(200, null, "{\"ok\":false,\"ok\":true,\"auth\":{},\"bridge_protocol\":1}") + "/"));
        assertNull(probe(serve(200, null, "{'ok':true,'auth':{},'bridge_protocol':1}") + "/"));
        assertNull(probe(serve(200, null, "{\"ok\":true,\"auth\":{},\"bridge_protocol\":1,}") + "/"));
        // a JSON escape takes ASCII hex digits only, not fullwidth ones
        assertNull(probe(serve(200, null, "{\"\\u\uFF10\uFF10\uFF16\uFF46\\u\uFF10\uFF10\uFF16\uFF42\":true,\"auth\":{},\"bridge_protocol\":1}") + "/"));
        String escaped = serve(200, null, "{\"\\u006f\\u006B\":true,\"auth\":{},\"bridge_protocol\":1}");
        assertEquals(escaped, probe(escaped + "/"));
        // nested deeper than the stack would take, inside the size limit
        assertNull(probe(serve(200, null, "[".repeat(60000)) + "/"));
        // malformed UTF-8, a byte 0xFF inside a string
        byte[] start = "{\"ok\":true,\"auth\":{},\"bridge_protocol\":1,\"x\":\"".getBytes(StandardCharsets.UTF_8);
        byte[] malformed = java.util.Arrays.copyOf(start, start.length + 3);
        malformed[start.length] = (byte) 0xFF;
        malformed[start.length + 1] = '"';
        malformed[start.length + 2] = '}';
        assertNull(probe(serve(200, null, malformed) + "/"));
        // whitespace around the value is JSON
        String ovis = serve(200, null, " \n" + OVIS + "\r\n");
        assertEquals(ovis, probe(ovis + "/"));
    }

    @Test
    public void theWayToOvisNeverGoesOverPublicHttpOrFromHttpsToHttp() {
        // https to http, on the redirect itself or on a later hop of the probe
        assertEquals("http://pc.example.com", PCStore.insecureHop("https://pc.example.com", Collections.singletonList("http://pc.example.com")));
        assertEquals("http://100.64.0.2", PCStore.insecureHop("https://pc.tail1234.ts.net", Collections.singletonList("http://100.64.0.2")));
        assertEquals("http://public.example.com", PCStore.insecureHop("http://100.64.0.1", java.util.Arrays.asList("https://candidate.example.com", "http://public.example.com")));
        // a public http address, which the connect screen warns before
        assertEquals("http://203.0.113.5:7421", PCStore.insecureHop("http://100.64.0.1", Collections.singletonList("http://203.0.113.5:7421")));
        // a tailnet or home address, or https all the way
        assertNull(PCStore.insecureHop("http://100.64.0.1", Collections.singletonList("http://pc.tail1234.ts.net:7421")));
        assertNull(PCStore.insecureHop("http://192.168.1.5", Collections.singletonList("http://mypc.local:7421")));
        assertNull(PCStore.insecureHop("http://10.0.2.2:7491", Collections.singletonList("http://localhost:7492")));
        assertNull(PCStore.insecureHop("http://100.64.0.1", Collections.singletonList("https://pc.example.com")));
        assertNull(PCStore.insecureHop("https://a.example.com", java.util.Arrays.asList("https://b.example.com", "https://c.example.com:8443")));
    }

    @Test
    public void publicHttpIsWhatTheConnectScreenWarnsAbout() {
        // a number in any form but a plain dotted quad is some IPv4 address to the web view, never judged private
        for (String warned : new String[] {"http://8.8.8.8", "http://172.15.0.1", "http://100.128.0.1", "http://[2001:db8::1]", "http://pc.example.com", "http://134744072:7421", "http://010.0.0.1", "http://0x8.8.8.8", "http://10.0.0.256", "http://134217729", "http://0x08000001"}) {
            assertTrue(warned, PCStore.publicHttp(warned));
        }
        for (String quiet : new String[] {"https://8.8.8.8", "http://10.1.2.3", "http://127.0.0.1:7421", "http://172.16.0.1", "http://192.168.0.9", "http://169.254.1.1", "http://100.64.0.1", "http://[::1]", "http://[fd7a:115c:a1e0::1]", "http://[fe80::1]", "http://pc", "http://localhost:7492", "http://pc.tail1234.ts.net", "http://pc.local", "http://pc.lan", "http://pc.home.arpa", "http://pc.internal"}) {
            assertFalse(quiet, PCStore.publicHttp(quiet));
        }
    }

    @Test
    public void aLoopIsNotOvis() throws IOException {
        String self = serve(302, "/api/health?scope=bridge", "");
        assertNull(probe(self + "/"));
    }

    @Test
    public void anAnswerThatNeverEndsIsNotOvisOnceTheBudgetIsSpent() throws IOException {
        assertNull(PCStore.ovisOrigin(serveSlowly(false) + "/", 300, new ArrayList<>()));
        assertNull(PCStore.ovisOrigin(serveSlowly(true) + "/", 300, new ArrayList<>()));
    }

    @Test
    public void anAddressNobodyAnswersOrThatIsNotHttpIsNotOvis() throws IOException {
        ServerSocket closed = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = closed.getLocalPort();
        closed.close();
        assertNull(probe("http://127.0.0.1:" + port + "/"));
        assertNull(probe("intent://scan/#Intent;scheme=zxing;end"));
    }

    @Test
    public void aRelayPcIsKeyedByItsScopeAndAnOldOriginKeyStillWorks() {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        String offer = scope + "#offer=eyJ2IjoxfQ";
        assertEquals(scope, PCStore.scopeKey(scope, offer));
        assertEquals(scope, PCStore.scopeKey(scope, scope));
        // another origin, a scope without its slash or with more than a path, or a page outside the scope
        assertNull(PCStore.scopeKey(scope, "https://evil.example/s/0123456789abcdef0123456789abcdef/#offer=x"));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef", offer));
        assertNull(PCStore.scopeKey(scope + "?x=1", offer));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/", offer));
        assertNull(PCStore.scopeKey(scope, "https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/"));

        assertTrue(PCStore.belongs(offer, scope));
        assertTrue(PCStore.belongs("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef", scope));
        assertFalse(PCStore.belongs("https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/", scope));
        assertFalse(PCStore.belongs("https://app.ovis.sh/", scope));
        // a PC saved by its origin before relay PCs: any page of that origin, as before
        assertTrue(PCStore.belongs("https://pc.tail1234.ts.net/settings?x=1", "https://pc.tail1234.ts.net"));
        assertFalse(PCStore.belongs("https://pc.tail1234.ts.net:8443/", "https://pc.tail1234.ts.net"));
        assertEquals("https://pc.tail1234.ts.net", PCStore.origin("https://pc.tail1234.ts.net"));
        assertEquals("https://app.ovis.sh", PCStore.origin(scope));
    }

    @Test
    public void aRelayLinkThatResolvesOutsideItsScopeIsRefused() {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        String other = "fedcba9876543210fedcba9876543210/";
        for (String escape : new String[] {
            scope + "../" + other,
            scope + "../../outside/",
            scope + "./x",
            scope + "%2e%2e/" + other,
            scope + "%2E%2E/" + other,
            scope + ".%2e/" + other,
            scope + "%252e%252e/" + other,
            scope + "..%2f" + other,
            scope + "x%2F..%2F..%2F" + other,
            scope + "..%5c" + other,
            scope + "x\\..\\..\\" + other,
            scope + "%zz",
        }) {
            assertNull(escape, PCStore.scopeKey(scope, escape));
            assertFalse(escape, PCStore.belongs(escape, scope));
        }
        // the scope's own segments: another PC whose id starts with this one's, and the scope without its slash
        assertFalse(PCStore.belongs("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef0/", scope));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef", scope + "#offer=x"));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/../" + other, scope));
        // pages deeper in the scope, and a name with dots that is not a dot segment
        assertEquals(scope, PCStore.scopeKey(scope, scope + "~render?x=1#offer=eyJ2IjoxfQ"));
        assertTrue(PCStore.belongs(scope + "deep/er/page.v2..html", scope));
        assertTrue(PCStore.belongs(scope + "caf%C3%A9/", scope));
        // a PC saved by its origin is unchanged
        assertTrue(PCStore.belongs("https://pc.tail1234.ts.net/a/../b", "https://pc.tail1234.ts.net"));
    }

    @Test
    public void cleanPathKeepsOnlyPathsABrowserLoadsAsWritten() {
        assertEquals("/s/a/b.c/", PCStore.cleanPath("/s/a/b.c/"));
        assertEquals("", PCStore.cleanPath(""));
        for (String bad : new String[] {"/..", "/.", "/a/%2e", "/a/%252E%252e/", "/a%2fb", "/a%5Cb", "/a\\b", "/a%", "/a%2", "/a%C3"}) {
            assertNull(bad, PCStore.cleanPath(bad));
        }
    }

    @Test
    public void theStartPathKeepsAPairingLinkOrOfferAndElseOpensThePcsScopeOrRoot() {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        assertEquals("/s/0123456789abcdef0123456789abcdef/#offer=eyJ2IjoxfQ", PCStore.startPath(scope + "#offer=eyJ2IjoxfQ", scope));
        assertEquals("/s/0123456789abcdef0123456789abcdef/", PCStore.startPath(null, scope));
        assertEquals("/", PCStore.startPath(null, "https://pc.tail1234.ts.net"));
        assertEquals("/?pair=123456", PCStore.startPath("https://pc.tail1234.ts.net/?pair=123456", "https://pc.tail1234.ts.net"));
        assertEquals("/", PCStore.startPath("https://other.example/?pair=123456", "https://pc.tail1234.ts.net"));
    }

    @Test
    public void theStartKeepsAPairingLinksCodeOnTheOvisOrigin() {
        assertEquals("https://pc.example.com/?pair=123456", PCStore.startOn("https://pc.example.com", "http://100.64.0.1/?pair=123456"));
        assertEquals("https://pc.example.com/", PCStore.startOn("https://pc.example.com", "http://100.64.0.1"));
    }
}
