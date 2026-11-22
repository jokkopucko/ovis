package sh.ovis.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
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

    @Rule
    public final Timeout timeout = Timeout.seconds(20);

    private final List<ServerSocket> servers = new ArrayList<>();

    private final List<String> requestLines = Collections.synchronizedList(new ArrayList<>());

    private String serve(int status, String location, String body) throws IOException {
        return serve(status, location, body.getBytes(StandardCharsets.UTF_8));
    }

    private String serve(int status, String location, byte[] bytes) throws IOException {
        String head = "HTTP/1.1 " + status + " Test\r\n" + (location == null ? "" : "Location: " + location + "\r\n")
            + "Content-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
        return listen((line, out) -> {
            out.write(head.getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
        });
    }

    private String serveSlowly(boolean headers) throws IOException {
        return listen((line, out) -> {
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
        void write(String requestLine, OutputStream out) throws IOException;
    }

    private String listen(Answer answer) throws IOException {
        ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        servers.add(server);
        Thread thread = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    BufferedReader request = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    String first = request.readLine();
                    requestLines.add(first);
                    for (String line = request.readLine(); line != null && !line.isEmpty(); line = request.readLine()) { }
                    OutputStream out = socket.getOutputStream();
                    answer.write(first, out);
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

    private String redirecting(int redirects, String end) throws IOException {
        String next = end;
        for (int i = 0; i < redirects; i++) next = serve(302, next + "/api/health?scope=bridge", "");
        return next;
    }

    private static String probe(String target) {
        return PCStore.ovisOrigin(target, PCStore.PROBE_BUDGET_MS, new ArrayList<>());
    }

    private String servePaths(String health, String page) throws IOException {
        return listen((line, out) -> {
            boolean asksHealth = line != null && line.startsWith("GET /api/health");
            String body = asksHealth ? health : page;
            byte[] bytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 " + (body == null ? "404" : "200") + " Test\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
        });
    }

    private static PCStore.Check check(String url) {
        return PCStore.check(url, null, PCStore.ANSWER_SECONDS * 1000L);
    }

    @After
    public void stop() throws IOException {
        for (ServerSocket server : servers) server.close();
    }

    @Test
    public void anOvisServerOfAnyVersionOrTheHostedAppIsOvis() throws IOException {
        assertEquals("ovis", check(serve(200, null, OVIS) + "/?pair=123456").kind);
        assertEquals("ovis", check(serve(200, null, "{\"ok\":true,\"herdr\":{\"version\":\"0.4\"},\"auth\":{\"required\":false,\"authenticated\":true}}") + "/").kind);
        String shell = "<!doctype html><html><head><meta name=\"ovis-shell\" content=\"relay\" /></head></html>";
        assertEquals("ovis", check(serve(200, null, shell) + "/").kind);
        requestLines.clear();
        String copy = servePaths(null, shell);
        assertEquals("ovis", check(copy + "/s/0123456789abcdef0123456789abcdef/#offer=abc").kind);
        assertEquals(java.util.Arrays.asList("GET /api/health?scope=bridge HTTP/1.1", "GET /s/0123456789abcdef0123456789abcdef/ HTTP/1.1"), requestLines);
    }

    @Test
    public void anotherWebServerIsNotOvisAndItsPageIsAskedWithoutThePairingCode() throws IOException {
        requestLines.clear();
        PCStore.Check page = check(servePaths("<!doctype html><title>Router</title>", "<!doctype html><title>Router</title>") + "/?pair=123456");
        assertEquals("not-ovis", page.kind);
        assertNull(page.detail);
        assertEquals(java.util.Arrays.asList("GET /api/health?scope=bridge HTTP/1.1", "GET / HTTP/1.1"), requestLines);
        PCStore.Check missing = check(servePaths(null, "<!doctype html><title>Dev server</title>") + "/");
        assertEquals("not-ovis", missing.kind);
        assertEquals("HTTP 404", missing.detail);
        assertEquals("not-ovis", check(serve(200, null, "{\"ok\":true}") + "/").kind);
    }

    @Test
    public void anAnswerThatDoesNotTellIsLeftToTheWebView() throws IOException {
        // Ovis stopped behind tailscale serve (502), a proxy or WAF that turns the probe away, a rate limit
        for (int status : new int[] {401, 403, 429, 500, 502, 503}) {
            PCStore.Check found = check(serve(status, null, "") + "/");
            assertEquals(status + "", "unsure", found.kind);
            assertEquals("HTTP " + status, found.detail);
            assertTrue(found.opens());
        }
        assertEquals("unsure", check(servePaths(null, null) + "/").kind);
    }

    @Test
    public void aConnectionThatFailsAtOnceIsRefusedUnlessTheHostCannotBeReached() {
        long later = System.nanoTime() + 60_000_000_000L;
        // Android's HttpURLConnection, for a closed port: no errno in the message, no cause
        assertEquals("refused", PCStore.failureKind(new java.net.ConnectException("Failed to connect to /192.168.0.10:7317"), later));
        IOException off = new java.net.ConnectException("Failed to connect to /192.168.0.11:7317");
        off.initCause(new java.net.NoRouteToHostException("connect failed: EHOSTUNREACH (No route to host)"));
        assertEquals("no-answer", PCStore.failureKind(off, later));
        assertEquals("no-answer", PCStore.failureKind(new java.net.ConnectException("connect failed: ENETUNREACH (Network is unreachable)"), later));
        assertEquals("timeout", PCStore.failureKind(new java.net.SocketTimeoutException("timeout"), later));
        assertEquals("unknown-host", PCStore.failureKind(new java.net.UnknownHostException("my-pc"), later));
    }

    @Test
    public void onlyTheLatestOpenNotCancelledGoesOn() {
        PCStore.Openings openings = new PCStore.Openings();
        int first = openings.start();
        int second = openings.start();
        assertFalse(openings.current(first));
        assertTrue(openings.current(second));
        openings.cancel();
        assertFalse(openings.current(second));
        assertTrue(openings.current(openings.start()));
    }

    @Test
    public void aRedirectIsLeftToTheWebView() throws IOException {
        PCStore.Check signIn = check(serve(302, "https://team.cloudflareaccess.com/login", "") + "/");
        assertEquals("in-front", signIn.kind);
        assertTrue(signIn.opens());
    }

    @Test
    public void saysWhyNoAnswerCame() throws IOException {
        ServerSocket closed = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        int port = closed.getLocalPort();
        closed.close();
        assertEquals("refused", check("http://127.0.0.1:" + port + "/").kind);
        assertEquals("unknown-host", check("http://no-such-pc.invalid:7317/").kind);
        PCStore.Check slow = PCStore.check(serveSlowly(true) + "/", null, 300);
        assertEquals("timeout", slow.kind);
        assertFalse(slow.opens());
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
        byte[] start = "{\"ok\":true,\"auth\":{},\"bridge_protocol\":1,\"x\":\"".getBytes(StandardCharsets.UTF_8);
        byte[] malformed = java.util.Arrays.copyOf(start, start.length + 3);
        malformed[start.length] = (byte) 0xFF;
        malformed[start.length + 1] = '"';
        malformed[start.length + 2] = '}';
        assertNull(probe(serve(200, null, malformed) + "/"));
        String ovis = serve(200, null, " \n" + OVIS + "\r\n");
        assertEquals(ovis, probe(ovis + "/"));
    }

    @Test
    public void theWayToOvisNeverGoesOverPublicHttpOrFromHttpsToHttp() {
        assertEquals("http://pc.example.com", PCStore.insecureHop("https://pc.example.com", Collections.singletonList("http://pc.example.com")));
        assertEquals("http://100.64.0.2", PCStore.insecureHop("https://pc.tail1234.ts.net", Collections.singletonList("http://100.64.0.2")));
        assertEquals("http://public.example.com", PCStore.insecureHop("http://100.64.0.1", java.util.Arrays.asList("https://candidate.example.com", "http://public.example.com")));
        assertEquals("http://203.0.113.5:7421", PCStore.insecureHop("http://100.64.0.1", Collections.singletonList("http://203.0.113.5:7421")));
        assertNull(PCStore.insecureHop("http://100.64.0.1", Collections.singletonList("http://pc.tail1234.ts.net:7421")));
        assertNull(PCStore.insecureHop("http://192.168.1.5", Collections.singletonList("http://mypc.local:7421")));
        assertNull(PCStore.insecureHop("http://10.0.2.2:7491", Collections.singletonList("http://localhost:7492")));
        assertNull(PCStore.insecureHop("http://100.64.0.1", Collections.singletonList("https://pc.example.com")));
        assertNull(PCStore.insecureHop("https://a.example.com", java.util.Arrays.asList("https://b.example.com", "https://c.example.com:8443")));
    }

    @Test
    public void aSignInInFrontOfThePcIsRefusedOnlyOverInsecureHttp() {
        List<String> probed = Collections.singletonList("https://team.cloudflareaccess.com");
        assertNull(PCStore.refusedHop("https://ovis.example.com", "https://team.cloudflareaccess.com/cdn-cgi/access/login", null, probed));
        assertNull(PCStore.refusedHop("http://100.64.0.1", "http://auth.tail1234.ts.net/sign_in", null, Collections.emptyList()));
        assertEquals("http://team.example.com", PCStore.refusedHop("https://ovis.example.com", "http://team.example.com/login", null, Collections.emptyList()));
        assertEquals("http://auth.example.com", PCStore.refusedHop("http://100.64.0.1", "http://auth.example.com/sign_in", null, Collections.emptyList()));
        // an address with no origin Java can read (an underscore in the host) is refused, not a crash
        assertEquals("https://auth_server.corp.example/login", PCStore.refusedHop("https://ovis.example.com", "https://auth_server.corp.example/login", null, Collections.emptyList()));
        assertNull(PCStore.refusedHop("http://100.64.0.1", "https://pc.example.com/", "https://pc.example.com", Collections.singletonList("https://pc.example.com")));
        assertEquals("http://pc.example.com", PCStore.refusedHop("https://a.example.com", "https://b.example.com/", "http://pc.example.com", java.util.Arrays.asList("https://b.example.com", "http://pc.example.com")));
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
        assertNull(PCStore.scopeKey(scope, "https://evil.example/s/0123456789abcdef0123456789abcdef/#offer=x"));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef", offer));
        assertNull(PCStore.scopeKey(scope + "?x=1", offer));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/", offer));
        assertNull(PCStore.scopeKey(scope, "https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/"));

        assertTrue(PCStore.belongs(offer, scope));
        assertTrue(PCStore.belongs("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef", scope));
        assertFalse(PCStore.belongs("https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/", scope));
        assertFalse(PCStore.belongs("https://app.ovis.sh/", scope));
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
        assertFalse(PCStore.belongs("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef0/", scope));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef", scope + "#offer=x"));
        assertNull(PCStore.scopeKey("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/../" + other, scope));
        assertEquals(scope, PCStore.scopeKey(scope, scope + "~render?x=1#offer=eyJ2IjoxfQ"));
        assertTrue(PCStore.belongs(scope + "deep/er/page.v2..html", scope));
        assertTrue(PCStore.belongs(scope + "caf%C3%A9/", scope));
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
        // a link with the default port written out keeps its offer: the app saved its PC under the scope without the port
        String explicit = "https://app.ovis.sh:443/s/0123456789abcdef0123456789abcdef/#offer=eyJ2IjoxfQ";
        assertEquals(scope, PCStore.appScope(explicit));
        assertEquals("/s/0123456789abcdef0123456789abcdef/#offer=eyJ2IjoxfQ", PCStore.startPath(explicit, PCStore.appScope(explicit)));
        assertEquals("/s/0123456789abcdef0123456789abcdef/#offer=eyJ2IjoxfQ", PCStore.startPath("https://APP.ovis.sh/s/0123456789abcdef0123456789abcdef/#offer=eyJ2IjoxfQ", scope));
        assertEquals("/s/0123456789abcdef0123456789abcdef/", PCStore.startPath("https://app.ovis.sh:8443/s/0123456789abcdef0123456789abcdef/#offer=eyJ2IjoxfQ", scope));
        assertEquals("/", PCStore.startPath(null, "https://pc.tail1234.ts.net"));
        assertEquals("/?pair=123456", PCStore.startPath("https://pc.tail1234.ts.net/?pair=123456", "https://pc.tail1234.ts.net"));
        assertEquals("/", PCStore.startPath("https://other.example/?pair=123456", "https://pc.tail1234.ts.net"));
    }

    @Test
    public void theStartKeepsAPairingLinksCodeOnTheOvisOrigin() {
        assertEquals("https://pc.example.com/?pair=123456", PCStore.startOn("https://pc.example.com", "http://100.64.0.1/?pair=123456"));
        assertEquals("https://pc.example.com/", PCStore.startOn("https://pc.example.com", "http://100.64.0.1"));
    }

    @Test
    public void takesOnlyAViewOfAPcOnTheHostedShellAsAnAppLink() {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        String offer = scope + "#offer=eyJ2IjoxfQ";
        for (String link : new String[] {
            offer,
            scope,
            "https://APP.ovis.sh:443/s/0123456789abcdef0123456789abcdef",
            scope + "#read=%2Fhome%2Fa.md&machine=local",
            scope + "?pane=w1%3Ap1",
        }) {
            assertEquals(link, PCStore.appLink("android.intent.action.VIEW", link));
            assertEquals(link, scope, PCStore.appScope(link));
        }
        assertNull(PCStore.appLink("android.intent.action.MAIN", offer));
        assertNull(PCStore.appLink("android.intent.action.VIEW", null));
        for (String other : new String[] {
            "http://app.ovis.sh/s/0123456789abcdef0123456789abcdef/",
            "https://app.ovis.sh:8443/s/0123456789abcdef0123456789abcdef/",
            "https://app.ovis.sh.evil.example/s/0123456789abcdef0123456789abcdef/",
            "https://app.ovis.sh/",
            "https://app.ovis.sh/sx/",
            "https://app.ovis.sh/s/not-a-pc",
            "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/sw.js",
            "ovis://account/callback?code=1",
            "https://app.ovis.sh/s/ bad",
        }) assertNull(other, PCStore.appLink("android.intent.action.VIEW", other));
    }

    @Test
    public void opensATappedAlertOnItsPaneInThePcThatSentIt() {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        String id = "0123456789abcdef0123456789abcdef";
        String home = "http://desktop.lan:7317";
        java.util.List<String> saved = java.util.Arrays.asList(home, scope, "https://laptop.example.ts.net");
        assertArrayEquals(new String[] { home, home + "/?machine=local&ws=w1&pane=w1%3Ap1&view=chat" },
            PCStore.alertLink(saved, home, id, null, "w1", "w1:p1"));
        assertArrayEquals(new String[] { home, home + "/?machine=build%20box&pane=w2%3Ap3&view=chat" },
            PCStore.alertLink(saved, home, null, "build box", null, "w2:p3"));
        assertArrayEquals(new String[] { scope, scope + "#machine=local&ws=w1&pane=w1%3Ap1&view=chat" },
            PCStore.alertLink(saved, "https://app.ovis.sh", id, "local", "w1", "w1:p1"));
        assertArrayEquals(new String[] { scope, scope + "#machine=local&pane=w1%3Ap1&view=chat" },
            PCStore.alertLink(saved, null, id, null, null, "w1:p1"));
        assertEquals("https://laptop.example.ts.net", PCStore.alertLink(saved, "https://laptop.example.ts.net", id, null, null, "w1:p1")[0]);
        assertNull(PCStore.alertLink(saved, home, id, null, null, null));
        assertNull(PCStore.alertLink(saved, home, id, null, null, ""));
        assertNull(PCStore.alertLink(saved, "http://forgotten.lan:7317", null, null, null, "w1:p1"));
        assertNull(PCStore.alertLink(saved, null, "fedcba9876543210fedcba9876543210", null, null, "w1:p1"));
        assertNull(PCStore.alertLink(saved, null, "../evil", null, null, "w1:p1"));
        assertNull(PCStore.alertLink(saved, null, null, null, null, "w1:p1"));
        // a relay ID never moves an alert from a saved address to the hosted shell
        assertNull(PCStore.alertLink(java.util.Collections.singletonList(scope), "http://forgotten.lan:7317", id, null, null, "w1:p1"));
        java.util.List<String> withList = java.util.Arrays.asList(home, scope, "https://app.ovis.sh");
        assertArrayEquals(new String[] { scope, scope + "#machine=local&pane=w1%3Ap1&view=chat" },
            PCStore.alertLink(withList, "https://app.ovis.sh", id, null, null, "w1:p1"));
    }

    @Test
    public void handsATappedAlertToTheOpenPageOfItsPcAndOpensAnyOtherPc() throws Exception {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        String id = "0123456789abcdef0123456789abcdef";
        String home = "http://desktop.lan:7317";
        String laptop = "https://laptop.example.ts.net";
        java.util.List<String> saved = java.util.Arrays.asList(home, scope, laptop, "https://app.ovis.sh");
        PCStore.AlertTap same = PCStore.alertTap(saved, home, home + "/?machine=local&pane=w1%3Ap0", home, id, null, "w1", "w1:p1");
        assertNull(same.address);
        org.json.JSONObject selection = new org.json.JSONObject(same.selection);
        assertEquals("select-pane", selection.getString("type"));
        assertEquals("w1:p1", selection.getString("pane_id"));
        assertEquals("local", selection.getString("machine_id"));
        assertEquals("chat", selection.getString("view"));
        assertEquals("w1", selection.getString("workspace_id"));
        // a relay PC's page at its scope too; the values reach the page as they came, whatever they hold
        String odd = "p\"); alert(1); //\u2028</script>";
        PCStore.AlertTap relay = PCStore.alertTap(saved, scope, scope + "#machine=local", "https://app.ovis.sh", id, "build box", null, odd);
        assertNull(relay.address);
        org.json.JSONObject relaySelection = new org.json.JSONObject(relay.selection);
        assertEquals(odd, relaySelection.getString("pane_id"));
        assertEquals("build box", relaySelection.getString("machine_id"));
        assertFalse(relaySelection.has("workspace_id"));
        PCStore.AlertTap other = PCStore.alertTap(saved, laptop, laptop + "/", home, id, null, "w1", "w1:p1");
        assertNull(other.selection);
        assertEquals(home, other.pc);
        assertEquals(home + "/?machine=local&ws=w1&pane=w1%3Ap1&view=chat", other.address);
        for (String shown : new String[] { null, "https://sso.example.com/login", scope }) {
            PCStore.AlertTap opened = PCStore.alertTap(saved, home, shown, home, id, null, null, "w1:p1");
            assertNull(shown, opened.selection);
            assertEquals(home + "/?machine=local&pane=w1%3Ap1&view=chat", opened.address);
        }
        assertNull(PCStore.alertTap(saved, home, home + "/", "http://forgotten.lan:7317", null, null, null, "w1:p1"));
        assertNull(PCStore.alertTap(saved, home, home + "/", home, id, null, null, null));
    }

    @Test
    public void handsATappedAlertOnlyToAnAppPageAndOpensItsAddressOverAReaderOrAFile() {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        String id = "0123456789abcdef0123456789abcdef";
        String home = "http://desktop.lan:7317";
        java.util.List<String> saved = java.util.Arrays.asList(home, scope);
        String homeAddress = home + "/?machine=local&pane=w1%3Ap1&view=chat";
        String scopeAddress = scope + "#machine=local&pane=w1%3Ap1&view=chat";
        for (String shown : new String[] {
            home, home + "/", home + "/index.html", home + "/?machine=local&pane=w1%3Ap0", home + "/?read=", home + "/?read=+%20%C2%A0",
            home + "/#read=notes.md",
        }) {
            PCStore.AlertTap tap = PCStore.alertTap(saved, home, shown, home, null, null, null, "w1:p1");
            assertNotNull(shown, tap.selection);
            assertNull(shown, tap.address);
        }
        for (String shown : new String[] { scope, scope + "#machine=local&pane=w1%3Ap0", scope + "?machine=local#read=notes.md" }) {
            assertNotNull(shown, PCStore.alertTap(saved, scope, shown, "https://app.ovis.sh", id, null, null, "w1:p1").selection);
        }
        for (String shown : new String[] {
            home + "/?read=notes.md", home + "/?machine=local&read=docs%2Fa.md", home + "/?%72ead=notes.md",
            home + "/api/file?path=a.html", home + "/ws", home + "/social-preview.png", home + "/notes.md",
        }) {
            PCStore.AlertTap tap = PCStore.alertTap(saved, home, shown, home, null, null, null, "w1:p1");
            assertNull(shown, tap.selection);
            assertEquals(shown, homeAddress, tap.address);
        }
        for (String shown : new String[] { scope + "#read=notes.md", scope + "#machine=local&read=a.md", scope + "?read=notes.md" }) {
            PCStore.AlertTap tap = PCStore.alertTap(saved, scope, shown, "https://app.ovis.sh", id, null, null, "w1:p1");
            assertNull(shown, tap.selection);
            assertEquals(shown, scopeAddress, tap.address);
        }
    }

    @Test
    public void pairsOnlyFromAPcsScopeOrItsOfferAndOpensAnyOtherLinkAsAView() {
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        assertTrue(PCStore.pairingLink(scope));
        assertTrue(PCStore.pairingLink(scope + "#offer=eyJ2IjoxfQ"));
        assertFalse(PCStore.pairingLink(scope + "#read=%2Fhome%2Fa.md&machine=local"));
        assertFalse(PCStore.pairingLink(scope + "#machine=local&pane=w1%3Ap1"));
        assertFalse(PCStore.pairingLink(scope + "?pane=w1%3Ap1"));
        assertFalse(PCStore.pairingLink(scope + "?pair=1#offer=eyJ2IjoxfQ"));
    }

    @Test
    public void opensAPairingLinkInPlaceOnlyOverTheHostedShell() {
        assertTrue(PCStore.showsHostedShell("https://app.ovis.sh"));
        assertTrue(PCStore.showsHostedShell("https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/"));
        assertFalse(PCStore.showsHostedShell(null));
        assertFalse(PCStore.showsHostedShell("http://desktop.lan:7317"));
        assertFalse(PCStore.showsHostedShell("https://app.ovis.sh.evil.example"));
        assertFalse(PCStore.showsHostedShell("http://app.ovis.sh"));
        assertTrue(PCStore.showsHostedShell("https://app.ovis.sh:443"));
        assertTrue(PCStore.showsHostedShell("https://APP.ovis.sh:443/s/0123456789abcdef0123456789abcdef/"));
        assertFalse(PCStore.showsHostedShell("https://app.ovis.sh:8443"));
        assertFalse(PCStore.showsHostedShell("http://app.ovis.sh:443"));
    }

    @Test
    public void aPageThatFinishesLoadingKeepsTheStartOfAnotherPcThatCameMeanwhile() {
        String a = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        String b = "https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/";
        String before = PCStore.pendingStart;
        try {
            PCStore.pendingStart = b + "#offer=eyJ2IjoxfQ";
            PCStore.startLoaded(a);
            assertEquals(b + "#offer=eyJ2IjoxfQ", PCStore.pendingStart);
            PCStore.startLoaded(b);
            assertNull(PCStore.pendingStart);
            PCStore.pendingStart = a + "#offer=eyJ2IjoxfQ";
            PCStore.startLoaded(a);
            assertNull(PCStore.pendingStart);
        } finally {
            PCStore.pendingStart = before;
        }
    }

    @Test
    public void backIsThePagesOnlyOverAnotherPageOfTheSamePlace() {
        String pc = "https://pc.tail1234.ts.net";
        assertTrue(PCStore.pageTakesBack(pc + "/?pane=w1%3Ap2", pc + "/?pane=w1%3Ap1", pc));
        assertFalse(PCStore.pageTakesBack(pc + "/", null, pc));
        assertFalse(PCStore.pageTakesBack(pc + "/", "https://login.example.com/authorize", pc));
        assertFalse(PCStore.pageTakesBack("https://login.example.com/step2", "https://login.example.com/authorize", pc));
        assertFalse(PCStore.pageTakesBack("https://localhost/error.html", pc + "/", pc));
        assertFalse(PCStore.pageTakesBack(pc + "/", "https://pc.tail1234.ts.net:8443/", pc));
        String scope = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
        assertTrue(PCStore.pageTakesBack(scope + "?pane=a", scope, scope));
        assertFalse(PCStore.pageTakesBack(scope, "https://app.ovis.sh/", scope));
        assertTrue(PCStore.pageTakesBack("https://localhost/demo/index.html", "https://localhost/", "https://localhost"));
        assertFalse(PCStore.pageTakesBack("https://localhost/", null, "https://localhost"));
    }

    @Test
    public void anotherPortOnThePcsHostIsAnotherOrigin() {
        String pc = "https://pc.example.ts.net";
        assertTrue(PCStore.sameOrigin(pc + "/files?x=1#top", pc));
        assertTrue(PCStore.sameOrigin("HTTPS://PC.example.ts.net:443/", pc));
        assertTrue(PCStore.sameOrigin(pc, "https://pc.example.ts.net:443"));
        assertTrue(PCStore.sameOrigin("http://pc.example.ts.net:80/", "http://pc.example.ts.net"));
        assertTrue(PCStore.sameOrigin("http://192.168.1.2:7317/a", "http://192.168.1.2:7317"));
        assertTrue(PCStore.sameOrigin("http://[::1]:80/", "http://[::1]"));
        assertFalse(PCStore.sameOrigin(pc + ":7231", pc));
        assertFalse(PCStore.sameOrigin(pc + ":7231/", pc + ":443"));
        assertFalse(PCStore.sameOrigin("http://192.168.1.2:3000/", "http://192.168.1.2:7317"));
        assertFalse(PCStore.sameOrigin("http://pc.example.ts.net", pc));
        assertFalse(PCStore.sameOrigin("https://pc.example.ts.net:80/", pc));
        assertFalse(PCStore.sameOrigin("https://other.example.ts.net", pc));
        assertFalse(PCStore.sameOrigin("https://pc.example.ts.net.evil.com", pc));
        assertFalse(PCStore.sameOrigin("ovis://pc.example.ts.net", "ovis://pc.example.ts.net"));
        assertFalse(PCStore.sameOrigin(null, pc));
    }
}
