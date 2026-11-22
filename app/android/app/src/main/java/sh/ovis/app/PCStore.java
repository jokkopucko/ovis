package sh.ovis.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The PCs this app knows, kept in SharedPreferences, as PCStore in the iOS app keeps them in
 * UserDefaults. The WebView's cookies (a paired device's sign-in) live in its own store.
 */
final class PCStore {
    private static final String PREFS = "herdr";
    private static final String JS_TRIM_WHITESPACE = "[\\s\\p{Z}\\uFEFF]";

    /** The address to open instead of the bare origin until a PC page loads: a pairing link keeps its code through Try again. In memory only, as it can hold that code. */
    static String pendingStart;

    /** A PC's page on the hosted shell the app was opened with (appLink), until the connect screen takes it. In memory only, as it can hold a pairing offer's code. */
    static volatile String link;

    private static final Pattern PC_SCOPE = Pattern.compile("/s/([0-9a-f]{32})/?");

    /**
     * `data` when an intent of `action` is a view of a PC on the hosted shell
     * (`https://app.ovis.sh/s/<server_id>/`, within the manifest's verified link), whatever its
     * fragment or query, else null: a link to another page of the hosted shell is not taken, so it
     * does not close the page that is open.
     */
    static String appLink(String action, String data) {
        if (!"android.intent.action.VIEW".equals(action) || data == null) return null;
        return appScope(data) == null ? null : data;
    }

    /** Whether the page the app shows (`current`, a saved key) is the hosted shell's: its own list, or one of its PCs. */
    static boolean showsHostedShell(String current) {
        return sameOrigin(current, "https://app.ovis.sh");
    }

    /**
     * The page of `pc` has loaded: the start address it was opened with is used up, unless it is
     * another PC's (a link that came while this page loaded, which the next start opens).
     */
    static void startLoaded(String pc) {
        String start = pendingStart;
        if (start != null && belongs(start, pc)) pendingStart = null;
    }

    static String appScope(String link) {
        URI uri;
        try {
            uri = new URI(link);
        } catch (URISyntaxException notAnAddress) {
            return null;
        }
        boolean hostedShell = "https".equalsIgnoreCase(uri.getScheme()) && "app.ovis.sh".equalsIgnoreCase(uri.getHost()) && (uri.getPort() == -1 || uri.getPort() == 443);
        Matcher scope = PC_SCOPE.matcher(uri.getRawPath() == null ? "" : uri.getRawPath());
        return hostedShell && scope.matches() ? "https://app.ovis.sh/s/" + scope.group(1) + "/" : null;
    }

    private static final Pattern SERVER_ID = Pattern.compile("[0-9a-f]{32}");

    /**
     * The PC is the one the alert's endpoint was made for (`origin`, the push module's key for it) when
     * that origin is a saved PC; a relay PC, which shares the hosted shell's origin with every other, is
     * named by its relay ID (`serverId`) instead. Its pane rides in the scope's fragment there, as the
     * hosted shell's host never hears it.
     */
    static String[] alertLink(List<String> saved, String origin, String serverId, String machine, String workspace, String pane) {
        if (pane == null || pane.isEmpty()) return null;
        String query = "machine=" + encoded(machine == null || machine.isEmpty() ? "local" : machine)
            + (workspace == null || workspace.isEmpty() ? "" : "&ws=" + encoded(workspace))
            + "&pane=" + encoded(pane) + "&view=chat";
        String key = origin(origin);
        // the hosted shell's own origin is every relay PC's, and "Your PCs" when that is saved: never the PC itself
        if (key != null && saved.contains(key) && !scoped(key) && !sameOrigin(key, "https://app.ovis.sh")) return new String[] { key, key + "/?" + query };
        if (serverId != null && SERVER_ID.matcher(serverId).matches()) {
            String scope = "https://app.ovis.sh/s/" + serverId + "/";
            if (saved.contains(scope) && (key == null || sameOrigin(key, scope))) return new String[] { scope, scope + "#" + query };
        }
        return null;
    }

    static final class AlertTap {
        final String pc;
        final String address;
        final String selection;

        private AlertTap(String pc, String address, String selection) {
            this.pc = pc;
            this.address = address;
            this.selection = selection;
        }
    }

    static AlertTap alertTap(List<String> saved, String current, String shown, String origin, String serverId, String machine, String workspace, String pane) {
        String[] link = alertLink(saved, origin, serverId, machine, workspace, pane);
        if (link == null) return null;
        if (!link[0].equals(current) || shown == null || !belongs(shown, current) || !appPage(shown, current)) return new AlertTap(link[0], link[1], null);
        try {
            JSONObject selection = new JSONObject()
                .put("type", "select-pane")
                .put("pane_id", pane)
                .put("machine_id", machine == null || machine.isEmpty() ? "local" : machine)
                .put("view", "chat");
            if (workspace != null && !workspace.isEmpty()) selection.put("workspace_id", workspace);
            return new AlertTap(link[0], null, selection.toString());
        } catch (JSONException never) {
            throw new IllegalStateException(never);
        }
    }

    static boolean appPage(String url, String key) {
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException notAnAddress) {
            return false;
        }
        String path = uri.getRawPath() == null ? "" : uri.getRawPath();
        if (path.startsWith("/api/") || path.equals("/ws")) return false;
        String last = path.substring(path.lastIndexOf('/') + 1);
        if (last.contains(".") && !last.equals("index.html")) return false;
        String search = uri.getRawQuery();
        String fragment = uri.getRawFragment();
        boolean fromFragment = scoped(key) && (search == null || search.isEmpty()) && fragment != null && !fragment.isEmpty();
        String read = queryValue(fromFragment ? fragment : search, "read");
        return read == null || read.replaceAll(JS_TRIM_WHITESPACE, "").isEmpty();
    }

    /** The first value of `name` in `query` (a raw query, `?` optional), decoded as URLSearchParams decodes it, or null. */
    private static String queryValue(String query, String name) {
        if (query == null) return null;
        for (String pair : (query.startsWith("?") ? query.substring(1) : query).split("&")) {
            int equals = pair.indexOf('=');
            if (formDecoded(equals < 0 ? pair : pair.substring(0, equals)).equals(name)) return formDecoded(equals < 0 ? "" : pair.substring(equals + 1));
        }
        return null;
    }

    private static String formDecoded(String text) {
        String spaced = text.replace('+', ' ');
        String decoded = percentDecoded(spaced);
        return decoded == null ? spaced : decoded;
    }

    /**
     * The script MainActivity runs in the open page with an AlertTap's `selection`, which goes in as a
     * JSON value, never as code. It is dispatched on the page's window as "ovis-select-pane"
     * (SELECT_PANE_EVENT in src/lib/notificationTarget.ts), which a page on plain http, with no
     * navigator.serviceWorker, hears too; that page cancels it.
     */
    static String selectionScript(String selection) {
        return "(() => { const data = " + selection + "; "
            + "if (window.dispatchEvent(new MessageEvent('ovis-select-pane', { data, cancelable: true }))) { "
            + "const worker = navigator.serviceWorker; if (worker) worker.dispatchEvent(new MessageEvent('message', { data })); } })()";
    }

    private static String encoded(String text) {
        try {
            return java.net.URLEncoder.encode(text, "UTF-8").replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException never) {
            throw new IllegalStateException(never);
        }
    }

    /**
     * Whether an app link is one to pair from: the PC's scope alone or with its pairing offer, which
     * the connect screen checks as it does a scanned QR code (app/web/shell.js relayLink). Any other
     * fragment or query is a view of the PC (a file, a pane), which opens only a PC already saved.
     */
    static boolean pairingLink(String link) {
        URI uri = URI.create(link);
        String fragment = uri.getRawFragment();
        return uri.getRawQuery() == null && (fragment == null || fragment.isEmpty() || fragment.startsWith("offer="));
    }

    static volatile String failure;

    static volatile String failureKind;

    /** A command to run on the PC that fixes the failure, which the error page shows to copy (an SSH PC's: SshFailure.command); else null. */
    static volatile String failureCommand;

    static void fail(String reason, String kind) {
        fail(reason, kind, null);
    }

    static void fail(String reason, String kind, String command) {
        failure = reason;
        failureKind = kind;
        failureCommand = command;
    }

    static final int ANSWER_SECONDS = 20;

    static volatile long answerBy;

    static final long PAGE_FLOOR_MS = 5000;

    /** Redirects in a row that made another origin the PC (MainActivity), so two servers that redirect to each other stop. */
    static volatile int redirects;

    static final int MAX_REDIRECTS = 5;

    private static final int PROBE_TIMEOUT_MS = 5000;

    static final long PROBE_BUDGET_MS = 10000;

    /** More than /api/health ever answers. */
    private static final int PROBE_MAX_BYTES = 64 * 1024;

    static final int MIN_BRIDGE_PROTOCOL = 1;
    static final int MAX_BRIDGE_PROTOCOL = 1;

    static final Object JSON_NULL = new Object();

    /** Ends a probe's request at its deadline: read timeouts alone let a server that trickles go on. */
    private static final ScheduledExecutorService PROBE_DEADLINE = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "ovis-probe-deadline");
        thread.setDaemon(true);
        return thread;
    });

    private PCStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static List<String> saved(Context context) {
        List<String> list = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString("saved", "[]"));
            for (int i = 0; i < array.length(); i++) list.add(array.getString(i));
        } catch (org.json.JSONException ignored) {
        }
        return list;
    }

    private static void setSaved(Context context, List<String> list) {
        prefs(context).edit().putString("saved", new JSONArray(list).toString()).apply();
    }

    static JSONObject names(Context context) {
        try {
            return new JSONObject(prefs(context).getString("names", "{}"));
        } catch (JSONException damaged) {
            return new JSONObject();
        }
    }

    static void setName(Context context, String key, String name) {
        JSONObject names = names(context);
        try {
            if (name == null) names.remove(key);
            else names.put(key, name);
        } catch (JSONException notStored) {
            return;
        }
        prefs(context).edit().putString("names", names.toString()).apply();
    }

    static String current(Context context) {
        return prefs(context).getString("current", null);
    }

    static void setCurrent(Context context, String origin) {
        prefs(context).edit().putString("current", origin).apply();
    }

    static String last(Context context) {
        return prefs(context).getString("last", null);
    }

    static void open(Context context, String key, String start) {
        prefs(context).edit().putString("current", key).putString("last", key).apply();
        pendingStart = start;
    }

    static synchronized void remember(Context context, String key) {
        List<String> list = saved(context);
        list.remove(key);
        list.add(0, key);
        setSaved(context, list);
    }

    private static long forgets;
    private static final Map<String, Long> forgottenAt = new java.util.HashMap<>();

    static synchronized long forgetCount() {
        return forgets;
    }

    static synchronized void rememberUnlessForgotten(Context context, String key, long since) {
        Long at = forgottenAt.get(key);
        if (at == null || at <= since) remember(context, key);
    }

    static synchronized void forget(Context context, String key) {
        forgottenAt.put(key, ++forgets);
        List<String> list = saved(context);
        list.remove(key);
        setSaved(context, list);
        setName(context, key, null);
        SharedPreferences.Editor edit = prefs(context).edit();
        if (key.equals(current(context))) edit.remove("current");
        if (key.equals(last(context))) edit.remove("last");
        edit.apply();
    }

    static String scopeKey(String scope, String url) {
        String origin = origin(scope);
        String path = rawPath(scope);
        if (origin == null || !origin.equals(origin(url)) || path.length() < 2 || !path.endsWith("/")) return null;
        return scope.equals(origin + path) && belongs(url, scope) ? scope : null;
    }

    /**
     * Whether `url` is a page of the PC `key`: on its origin, and for a relay PC within its scope, path
     * segment by path segment (`/s/A/` is not within `/s/AB/`) and only as a browser would load it
     * (cleanPath): `<scope>../<other>/` resolves to another PC. A PC saved by its origin takes any page of it.
     */
    static boolean belongs(String url, String key) {
        String origin = origin(url);
        if (origin == null || !origin.equals(origin(key))) return false;
        String scope = rawPath(key);
        if (scope.isEmpty() || scope.equals("/")) return true;
        String path = cleanPath(rawPath(url));
        return path != null && cleanPath(scope) != null && scope.endsWith("/") && (path.endsWith("/") ? path : path + "/").startsWith(scope);
    }

    static boolean scoped(String key) {
        String scope = rawPath(key);
        return !scope.isEmpty() && !scope.equals("/");
    }

    static boolean pageTakesBack(String here, String before, String place) {
        return here != null && before != null && belongs(here, place) && belongs(before, place);
    }

    /**
     * `path` (percent-encoded, as a URL carries it) when a browser loads it as written, else null: no
     * `.` or `..` segment, plain or percent-encoded (once or twice), no encoded `/` and no `\`, which a
     * browser reads as `/`. A page within a scope never needs any of them.
     */
    static String cleanPath(String path) {
        if (path == null || path.indexOf('\\') >= 0) return null;
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.contains("%2f") || lower.contains("%5c")) return null;
        String decoded = percentDecoded(path);
        if (decoded == null || decoded.indexOf('\\') >= 0) return null;
        String twice = decoded.toLowerCase(Locale.ROOT);
        if (twice.contains("%2e") || twice.contains("%2f") || twice.contains("%5c")) return null;
        for (String segment : decoded.split("/", -1)) {
            if (segment.equals(".") || segment.equals("..")) return null;
        }
        return path;
    }

    private static String percentDecoded(String text) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c != '%') {
                byte[] bytes = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(bytes, 0, bytes.length);
                continue;
            }
            if (i + 2 >= text.length()) return null;
            int high = Character.digit(text.charAt(i + 1), 16), low = Character.digit(text.charAt(i + 2), 16);
            if (high < 0 || low < 0 || text.charAt(i + 1) > 'f' || text.charAt(i + 2) > 'f') return null;
            out.write(high * 16 + low);
            i += 2;
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray()))
                .toString();
        } catch (java.nio.charset.CharacterCodingException malformed) {
            return null;
        }
    }

    static String startPath(String start, String key) {
        // the default port written out (https://app.ovis.sh:443/...) is the same origin as the key saved without it
        String origin = normalizedOrigin(key);
        if (start == null || origin == null || !origin.equals(normalizedOrigin(start))) {
            String scope = rawPath(key);
            return scope.isEmpty() ? "/" : scope;
        }
        return startOn(origin, start).substring(origin.length());
    }

    private static String rawPath(String text) {
        try {
            String path = new URI(text).getRawPath();
            return path == null ? "" : path;
        } catch (URISyntaxException e) {
            return "";
        }
    }

    /**
     * Asks `/api/health?scope=bridge`,
     * which Ovis answers to anyone so a client can find its gate, and follows at most MAX_REDIRECTS
     * redirects of that request: a sign-in page, another site, a loop or no answer is not Ovis. Only
     * such an origin may become the PC, the one origin that gets Capacitor's bridge.
     */
    static String ovisOrigin(String target, long budgetMs, List<String> path) {
        long deadline = System.nanoTime() + budgetMs * 1_000_000L;
        String next = origin(target);
        for (int hops = 0; next != null && hops <= MAX_REDIRECTS; hops++) {
            long left = (deadline - System.nanoTime()) / 1_000_000L;
            if (left <= 0) return null;
            path.add(next);
            HttpURLConnection connection = null;
            ScheduledFuture<?> stop = null;
            try {
                URL health = new URL(next + "/api/health?scope=bridge");
                connection = (HttpURLConnection) health.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setConnectTimeout((int) Math.min(PROBE_TIMEOUT_MS, left));
                connection.setReadTimeout((int) Math.min(PROBE_TIMEOUT_MS, left));
                stop = PROBE_DEADLINE.schedule(connection::disconnect, left, TimeUnit.MILLISECONDS);
                connection.setRequestProperty("Accept", "application/json");
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    next = location == null ? null : origin(health.toURI().resolve(location).toString());
                    continue;
                }
                if (status != 200) return null;
                return answersAsOvis(json(text(connection.getInputStream(), deadline))) ? next : null;
            } catch (IOException | URISyntaxException | IllegalArgumentException notOvis) {
                return null;
            } finally {
                if (stop != null) stop.cancel(false);
                if (connection != null) connection.disconnect();
            }
        }
        return null;
    }

    static boolean answersAsOvis(Object answer) {
        if (!(answer instanceof Map)) return false;
        Map<?, ?> health = (Map<?, ?>) answer;
        Object version = health.get("bridge_protocol");
        return Boolean.TRUE.equals(health.get("ok")) && health.get("auth") instanceof Map
            && version instanceof BigInteger
            && ((BigInteger) version).compareTo(BigInteger.valueOf(MIN_BRIDGE_PROTOCOL)) >= 0
            && ((BigInteger) version).compareTo(BigInteger.valueOf(MAX_BRIDGE_PROTOCOL)) <= 0;
    }

    static final class Openings {
        private int last;

        synchronized int start() {
            return ++last;
        }

        synchronized void cancel() {
            last++;
        }

        synchronized boolean current(int ticket) {
            return ticket == last;
        }
    }

    static final class Check {
        final String kind;
        final String detail;

        Check(String kind, String detail) {
            this.kind = kind;
            this.detail = detail;
        }

        boolean opens() {
            return kind.equals("ovis") || kind.equals("in-front") || kind.equals("unsure");
        }
    }

    /**
     * Whether `url` is Ovis, before the app opens it as a PC or keeps it: asks its origin's
     * `/api/health?scope=bridge`, which every Ovis since 0.1 answers to anyone with `ok` and `auth`
     * (older ones without `bridge_protocol`, so this is looser than answersAsOvis, which decides
     * which origin gets the bridge). A redirect is left to the WebView, as a sign-in in front of the PC
     * (Cloudflare Access) answers so. The hosted app (app.ovis.sh, or a copy of it) has no
     * /api/health: its page says what it is (`<meta name="ovis-shell">`, scripts/shell-build.ts), on
     * the answer itself where every path serves it, else on `url`'s own page (its path only, never a
     * pairing link's code). `cookies` (the WebView's for the origin, or null) go with both requests.
     */
    static Check check(String url, String cookies, long budgetMs) {
        String origin = origin(url);
        if (origin == null) return new Check("no-answer", "not an http or https address");
        long deadline = System.nanoTime() + budgetMs * 1_000_000L;
        Answer health;
        try {
            health = fetch(origin + "/api/health?scope=bridge", cookies, deadline);
        } catch (IOException failed) {
            return new Check(failureKind(failed, deadline), String.valueOf(failed.getMessage()));
        }
        if (health.status >= 300 && health.status < 400) return new Check("in-front", null);
        if (health.status == 200 && (answersAsServer(health.body) || hostedApp(health.body))) return new Check("ovis", null);
        // only an answer that tells: Ovis stopped behind tailscale serve answers 502, a proxy or WAF may
        // answer the probe 401, 403 or 429 where the WebView gets in
        if (health.status != 200 && health.status != 404) return new Check("unsure", "HTTP " + health.status);
        Answer page;
        try {
            page = fetch(origin + cleanStart(url), cookies, deadline);
        } catch (IOException noPage) {
            return new Check("unsure", null);
        }
        if (page.status == 200 && hostedApp(page.body)) return new Check("ovis", null);
        if (page.status == 200) return new Check("not-ovis", health.status == 200 ? null : "HTTP " + health.status);
        return new Check("unsure", "HTTP " + health.status);
    }

    static boolean answersAsServer(String body) {
        Object answer;
        try {
            answer = json(body);
        } catch (IllegalArgumentException notJson) {
            return false;
        }
        return answer instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) answer).get("ok")) && ((Map<?, ?>) answer).get("auth") instanceof Map;
    }

    private static final Pattern SHELL_META = Pattern.compile("<meta\\s+name=\"ovis-shell\"", Pattern.CASE_INSENSITIVE);

    static boolean hostedApp(String body) {
        return SHELL_META.matcher(body).find();
    }

    /** `url`'s path alone ("/" when it has none): the page to ask, without a pairing link's code. */
    private static String cleanStart(String url) {
        String path = rawPath(url);
        return path.isEmpty() ? "/" : path;
    }

    static String failureKind(IOException failed, long deadline) {
        if (failed instanceof java.net.UnknownHostException) return "unknown-host";
        if (failed instanceof java.net.SocketTimeoutException || System.nanoTime() >= deadline) return "timeout";
        // a connection that fails before the timeout was refused: Android's HttpURLConnection says only
        // "Failed to connect to /host:port", with no cause; a host or network that cannot be reached (a
        // PC that is off) says so here or in a cause
        if (!(failed instanceof java.net.ConnectException)) return "no-answer";
        for (Throwable cause = failed; cause != null; cause = cause.getCause()) {
            String message = String.valueOf(cause.getMessage());
            if (cause instanceof java.net.NoRouteToHostException || message.contains("UNREACH") || message.contains("No route")) return "no-answer";
        }
        return "refused";
    }

    private static final class Answer {
        final int status;
        final String body;

        Answer(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static Answer fetch(String url, String cookies, long deadline) throws IOException {
        // rounded up, so the disconnect comes at the deadline or after it, and failureKind reads it as a timeout
        long left = (deadline - System.nanoTime() + 999_999L) / 1_000_000L;
        if (left <= 0) throw new java.net.SocketTimeoutException("no answer in time");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        ScheduledFuture<?> stop = PROBE_DEADLINE.schedule(connection::disconnect, left, TimeUnit.MILLISECONDS);
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout((int) left);
            connection.setReadTimeout((int) left);
            if (cookies != null && !cookies.isEmpty()) connection.setRequestProperty("Cookie", cookies);
            int status = connection.getResponseCode();
            if (status != 200) return new Answer(status, "");
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int read; out.size() < PROBE_MAX_BYTES && (read = in.read(buffer)) != -1; ) {
                    out.write(buffer, 0, read);
                    if (System.nanoTime() > deadline) throw new java.net.SocketTimeoutException("answer too slow");
                }
                return new Answer(status, new String(out.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            stop.cancel(false);
            connection.disconnect();
        }
    }

    /**
     * The first origin of `path`, the way from the address being opened (`from`) to an Ovis server,
     * that went over plain http the app should not switch to on its own: a public address (the connect
     * screen warns before one, as `publicHttp` in app/web/shell.js) or any http after https. Null when
     * the whole way is fine.
     */
    static String insecureHop(String from, List<String> path) {
        boolean https = from != null && from.startsWith("https://");
        for (String hop : path) {
            if (hop.startsWith("https://")) https = true;
            else if (https || publicHttp(hop)) return hop;
        }
        return null;
    }

    /**
     * The origin on the way from the address being opened (`from`) to a held-back redirect's `target`
     * that the app refuses to go to on its own, or null. With `ovis`, the Ovis server ovisOrigin found
     * over `path`, it is judged by that whole way (insecureHop). Without one the target is taken for a
     * sign-in in front of the PC, which loads without the bridge: judged by the target's own origin,
     * as the probe's later hops are not where the WebView goes; a target with no origin this class can
     * read (an underscore in its host) is refused as it is.
     */
    static String refusedHop(String from, String target, String ovis, List<String> path) {
        if (ovis != null) return insecureHop(from, path);
        String next = origin(target);
        return next == null ? target : insecureHop(from, Collections.singletonList(next));
    }

    private static final Pattern IPV4 = Pattern.compile("^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})$");
    private static final Pattern NUMBER_LABEL = Pattern.compile("[0-9]+|0[xX][0-9a-fA-F]*");
    private static final Pattern HOME_NAME = Pattern.compile(".*\\.(ts\\.net|local|lan|home\\.arpa|internal)$");

    /** Whether `origin` is plain http to an address outside a tailnet or a home network, as `publicHttp` in app/web/shell.js decides. */
    static boolean publicHttp(String origin) {
        if (origin == null || !origin.startsWith("http://")) return false;
        String host;
        try {
            host = new URI(origin).getHost();
        } catch (URISyntaxException e) {
            return true;
        }
        if (host == null) return true;
        host = host.replaceAll("^\\[|\\]$", "").toLowerCase(Locale.ROOT);
        // a host whose last label is a number is an IPv4 address to the web view in any form
        // (134744072, 010.0.0.1, 0x8.8.8.8), which shell.js sees rewritten: only a plain dotted quad
        // is judged here, any other form counts as public
        if (NUMBER_LABEL.matcher(host.substring(host.lastIndexOf('.') + 1)).matches()) {
            Matcher ipv4 = IPV4.matcher(host);
            if (!ipv4.matches()) return true;
            int[] part = new int[4];
            for (int i = 0; i < 4; i++) {
                part[i] = Integer.parseInt(ipv4.group(i + 1));
                if (part[i] > 255) return true;
            }
            int a = part[0], b = part[1];
            // 10/8, 127/8, 172.16/12, 192.168/16, link-local 169.254/16, and Tailscale's 100.64/10
            return !(a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127));
        }
        // ::1, unique local fc00::/7 (Tailscale's fd7a:115c:a1e0::/48 among them) and link-local fe80::/10
        if (host.contains(":")) return !(host.equals("::1") || host.matches("^f[cd].*") || host.matches("^fe[89ab].*"));
        // a one-word name (a MagicDNS short name, localhost) or a tailnet or home network name
        return host.contains(".") && !HOME_NAME.matcher(host).matches();
    }

    /**
     * Reads a JSON text (RFC 8259) strictly, where org.json takes unquoted names and stops before
     * whatever follows the value: the whole text is one value, names are quoted and come once per
     * object. Objects come as Maps, arrays as Lists, null as JSON_NULL, a number written without a
     * fraction or exponent as a BigInteger and any other as a BigDecimal. Throws
     * IllegalArgumentException for anything else.
     */
    static Object json(String text) {
        StrictJson reader = new StrictJson(text);
        Object value = reader.value();
        reader.space();
        if (reader.at != text.length()) throw reader.error();
        return value;
    }

    private static final class StrictJson {
        /** Deeper nesting than any health answer, and short of the stack a hostile answer could exhaust. */
        private static final int MAX_DEPTH = 32;
        private final String text;
        private int at;
        private int depth;

        StrictJson(String text) {
            this.text = text;
        }

        IllegalArgumentException error() {
            return new IllegalArgumentException("not JSON at " + at);
        }

        void space() {
            while (at < text.length() && " \t\n\r".indexOf(text.charAt(at)) >= 0) at++;
        }

        char next() {
            if (at >= text.length()) throw error();
            return text.charAt(at++);
        }

        void word(String word) {
            if (!text.startsWith(word, at)) throw error();
            at += word.length();
        }

        Object value() {
            space();
            if (at >= text.length()) throw error();
            char c = text.charAt(at);
            if (c == '{' || c == '[') {
                if (++depth > MAX_DEPTH) throw error();
                Object nested = c == '{' ? object() : array();
                depth--;
                return nested;
            }
            if (c == '"') return string();
            if (c == 't') { word("true"); return Boolean.TRUE; }
            if (c == 'f') { word("false"); return Boolean.FALSE; }
            if (c == 'n') { word("null"); return JSON_NULL; }
            if (c == '-' || (c >= '0' && c <= '9')) return number();
            throw error();
        }

        Map<String, Object> object() {
            at++;
            Map<String, Object> map = new LinkedHashMap<>();
            space();
            if (at < text.length() && text.charAt(at) == '}') {
                at++;
                return map;
            }
            while (true) {
                space();
                if (at >= text.length() || text.charAt(at) != '"') throw error();
                String name = string();
                if (map.containsKey(name)) throw error();
                space();
                if (next() != ':') throw error();
                map.put(name, value());
                space();
                char c = next();
                if (c == '}') return map;
                if (c != ',') throw error();
            }
        }

        List<Object> array() {
            at++;
            List<Object> list = new ArrayList<>();
            space();
            if (at < text.length() && text.charAt(at) == ']') {
                at++;
                return list;
            }
            while (true) {
                list.add(value());
                space();
                char c = next();
                if (c == ']') return list;
                if (c != ',') throw error();
            }
        }

        String string() {
            at++;
            StringBuilder out = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') return out.toString();
                if (c < 0x20) throw error();
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char escape = next();
                switch (escape) {
                    case '"': case '\\': case '/': out.append(escape); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        int code = 0;
                        for (int i = 0; i < 4; i++) {
                            // ASCII hex only: Character.digit also takes other scripts' digits and fullwidth letters
                            char hex = next();
                            int digit = hex >= '0' && hex <= '9' ? hex - '0' : hex >= 'a' && hex <= 'f' ? hex - 'a' + 10 : hex >= 'A' && hex <= 'F' ? hex - 'A' + 10 : -1;
                            if (digit < 0) throw error();
                            code = code * 16 + digit;
                        }
                        out.append((char) code);
                        break;
                    default: throw error();
                }
            }
        }

        Object number() {
            int start = at;
            if (text.charAt(at) == '-') at++;
            if (at < text.length() && text.charAt(at) == '0') at++;
            else digits();
            boolean integer = true;
            if (at < text.length() && text.charAt(at) == '.') {
                at++;
                digits();
                integer = false;
            }
            if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
                at++;
                if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) at++;
                digits();
                integer = false;
            }
            String token = text.substring(start, at);
            try {
                return integer ? new BigInteger(token) : new BigDecimal(token);
            } catch (NumberFormatException tooLarge) {
                throw error();
            }
        }

        void digits() {
            int start = at;
            while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
            if (at == start) throw error();
        }
    }

    /** `target`'s path, query and fragment on `origin`: a pairing link keeps its code when its server's /api/health redirected to another origin. */
    static String startOn(String origin, String target) {
        try {
            URI uri = new URI(target);
            String path = uri.getRawPath();
            return origin + (path == null || path.isEmpty() ? "/" : path) + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()) + (uri.getRawFragment() == null ? "" : "#" + uri.getRawFragment());
        } catch (URISyntaxException e) {
            return origin + "/";
        }
    }

    private static String text(InputStream stream, long deadline) throws IOException {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) != -1; ) {
                out.write(buffer, 0, read);
                if (out.size() > PROBE_MAX_BYTES) throw new IOException("answer too long");
                // a body that trickles in ends here too, should the disconnect at the deadline not stop the read at once
                if (System.nanoTime() > deadline) throw new IOException("answer too slow");
            }
            // malformed UTF-8 is not JSON: a decoder that reports it, where toString would put in U+FFFD
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray()))
                .toString();
        }
    }

    /**
     * Whether two http(s) addresses are on one origin: scheme, host and port, the scheme's default port
     * (80, 443) the same as none, as a browser compares them. Capacitor's own "stays in the WebView" test
     * compares scheme and host only, so another port on the PC's host passes it.
     */
    static boolean sameOrigin(String a, String b) {
        String first = normalizedOrigin(a);
        return first != null && first.equals(normalizedOrigin(b));
    }

    private static String normalizedOrigin(String text) {
        String origin = origin(text);
        if (origin == null) return null;
        return origin.replaceFirst("^(https://.*):443$", "$1").replaceFirst("^(http://.*):80$", "$1");
    }

    /** scheme://host[:port] of a well-formed http or https address, the host in lowercase, or null: `http://pc:abc/` is refused, not saved for Capacitor to fail on at the next start. */
    static String origin(String text) {
        if (text == null) return null;
        URI uri;
        try {
            uri = new URI(text).parseServerAuthority();
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? null : uri.getHost().toLowerCase(Locale.ROOT);
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https")) || host == null || host.isEmpty()) return null;
        return uri.getPort() == -1 ? scheme + "://" + host : scheme + "://" + host + ":" + uri.getPort();
    }
}
